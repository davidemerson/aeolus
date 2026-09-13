import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiRequestError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { type SynctexMap } from '../lib/synctex.js';

export type CompileState = 'idle' | 'running' | 'success' | 'error';

// The server hands back a path relative to /api (the same convention as
// checkpoint download_url in routes/checkpoints.ts). Three cases have to work
// without double-prefixing:
//   - absolute "http(s)://…" — a presigned cross-origin S3 URL, pass through
//   - "/api/…" — already prefixed (the e2e mock presigner returns these)
//   - "/docs/…" — the production fallback path, needs /api so it routes
//     through the SPA's same-origin proxy
// Shared by the compile-status poll and the mount restore so the two cannot
// drift apart.
function resolvePdfUrl(pdfUrl: string): string {
  return /^https?:\/\//.test(pdfUrl) || pdfUrl.startsWith('/api/') ? pdfUrl : `/api${pdfUrl}`;
}

// setTimeout that also returns early when the signal aborts, so the poll
// loop's back-off never outlives the component that started it.
function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// GET /docs/:id/compile/latest — the newest successful compile, or undefined
// (204) when the doc has never compiled successfully.
interface LatestCompile {
  job_id: string;
  rev: string;
  pdf_url: string | null;
  finished_at: string | null;
  warnings?: string[];
  // Whether that PDF still matches the project's current contents. Computed
  // server-side (see isCompileCurrent in routes/compile.ts) because it depends
  // on per-file Yjs timestamps the SPA has no view of.
  is_current: boolean;
}

export interface UseCompileLifecycleResult {
  compileState: CompileState;
  compileError: string | null;
  // Non-fatal findings on the last successful compile (#80) — fonts the
  // PDF references but does not embed. Empty when clean.
  compileWarnings: string[];
  compileStartedAt: number | null;
  compileFinishedAt: number | null;
  pdfUrl: string | null;
  syncMap: SynctexMap | null;
  // Manual trigger from the Compile button or Cmd/Ctrl+S. Updates
  // state in place and resolves when the compile finishes (success
  // or failure) or the 60s poll deadline expires.
  triggerCompile: () => Promise<void>;
}

// Owns the per-doc compile lifecycle: status state, the polling
// state machine, the synctex-map restore on mount, and a one-shot
// compile fired the first time the doc loads. Extracted from
// doc-editor.tsx (issue #46). Side-effects the route still owns
// (e.g. flipping the right-pane tab to "logs" on failure) happen
// via the route observing `compileState === 'error'` in a
// downstream useEffect — keeps this hook pure.
export function useCompileLifecycle(docId: string, docLoaded: boolean): UseCompileLifecycleResult {
  const session = useSession();
  const [compileState, setCompileState] = useState<CompileState>('idle');
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileWarnings, setCompileWarnings] = useState<string[]>([]);
  const [compileStartedAt, setCompileStartedAt] = useState<number | null>(null);
  const [compileFinishedAt, setCompileFinishedAt] = useState<number | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [syncMap, setSyncMap] = useState<SynctexMap | null>(null);
  // Tracks which docId we have already compiled on open for, so an
  // in-place docId switch (route stays mounted, just navigates to
  // a different doc) doesn't refire the compile-on-open every time
  // triggerCompile's identity changes. React StrictMode's
  // mount-unmount-remount cycle in dev still fires twice — the
  // worker is idempotent at the rev level and there is no
  // StrictMode in production.
  const openedForDocRef = useRef<string | null>(null);
  // Aborted on unmount so a compile poll that is mid-flight when the
  // route goes away stops: no further status requests, no setState on
  // an unmounted tree. Created inside an effect (not useRef's
  // initialiser) so StrictMode's mount-unmount-remount gets a fresh,
  // un-aborted controller on the second mount.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, []);

  // Restore the synctex map from the doc's most recent successful
  // compile on page mount, so PDF↔editor jumps work without forcing
  // the user to recompile after a refresh.
  //
  // 204 (empty body -> undefined) = no usable sync map: never
  // compiled, typst engine, or a parse failure. That is the normal
  // case, not an error, so it must not overwrite a map a compile
  // finishing in parallel has already installed — hence the
  // undefined guard rather than an unconditional setSyncMap.
  useEffect(() => {
    if (session.status !== 'authenticated' || !docLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const sx = await api.get<SynctexMap | undefined>(
          `/docs/${encodeURIComponent(docId)}/synctex/latest`,
        );
        if (!cancelled && sx !== undefined) setSyncMap(sx);
      } catch {
        // 403 / network — not user-fatal; the next compile will
        // refresh the map.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, session.status, docLoaded]);

  const triggerCompile = useCallback(async () => {
    const signal = abortRef.current?.signal ?? null;
    const cancelled = (): boolean => signal?.aborted ?? false;
    setCompileState('running');
    setCompileError(null);
    setCompileWarnings([]);
    setCompileStartedAt(Date.now());
    setCompileFinishedAt(null);
    try {
      const res = await api.post<{
        job_id: string;
        status: string;
      }>(`/docs/${encodeURIComponent(docId)}/compile`);
      if (cancelled()) return;

      const jobId = res.job_id;
      const deadline = Date.now() + 60_000;
      // Stepped backoff so a slow compile doesn't pin the API at
      // 2 polls/sec for a full minute. 5 fast polls catch fast
      // compiles (typst, cached LaTeX); a slower cadence drains
      // long ones with ~25 calls instead of ~120 over the same
      // 60s window.
      const pollDelays = [500, 500, 500, 500, 500, 1000, 1000, 1000, 1000, 1000, 2000];
      let pollIdx = 0;
      while (!cancelled() && Date.now() < deadline) {
        const status = await api.get<{
          status: string;
          pdf_url: string | null;
          synctex_url: string | null;
          error: string | null;
          warnings?: string[];
        }>(`/docs/${encodeURIComponent(docId)}/compile/${encodeURIComponent(jobId)}`);
        if (cancelled()) return;

        if (status.status === 'success') {
          setCompileState('success');
          setCompileFinishedAt(Date.now());
          if (status.pdf_url) setPdfUrl(resolvePdfUrl(status.pdf_url));
          // Fetch the parsed synctex map alongside the PDF when the
          // compile produced one (LaTeX only). A failure here is
          // non-fatal: PdfPreview just disables click-to-source and
          // forward jumps until the next successful compile.
          if (status.synctex_url) {
            try {
              const sx = await api.get<SynctexMap>(status.synctex_url);
              if (cancelled()) return;
              setSyncMap(sx);
            } catch {
              if (cancelled()) return;
              setSyncMap(null);
            }
          } else {
            setSyncMap(null);
          }
          // The engine log is only persisted on failure; what a
          // successful compile carries is `warnings` — non-fatal
          // findings such as a non-embedded font (#80), which the
          // previewer would otherwise mask.
          setCompileError(status.error);
          setCompileWarnings(status.warnings ?? []);
          return;
        }
        if (status.status === 'failed') {
          setCompileState('error');
          setCompileFinishedAt(Date.now());
          setCompileError(status.error ?? 'Compile failed');
          return;
        }
        const delay = pollDelays[Math.min(pollIdx, pollDelays.length - 1)];
        pollIdx += 1;
        await sleep(delay, signal);
      }
      if (cancelled()) return;
      setCompileState('error');
      setCompileFinishedAt(Date.now());
      setCompileError('The compile did not finish in time. Try again in a minute.');
    } catch (err) {
      if (cancelled()) return;
      setCompileState('error');
      setCompileFinishedAt(Date.now());
      setCompileError(err instanceof ApiRequestError ? err.message : 'Compile request failed');
    }
  }, [docId]);

  // Restore-then-maybe-compile, the first time the doc becomes available
  // (issue #72). Two things happen here, in this order, and the order is the
  // point:
  //
  //  1. Put the last successful PDF on screen IMMEDIATELY. The preview pane
  //     used to sit empty until a fresh compile finished — measured at ~8s on
  //     a trivial typst document with a warm worker, and worse through
  //     tectonic — while a perfectly good PDF for that exact content already
  //     existed in S3. Every refresh, every deep link and every navigation
  //     back into a document paid it.
  //
  //  2. Compile only if that PDF is stale. `is_current` comes from the server
  //     because the freshness rule spans per-file Yjs update timestamps the
  //     SPA has no view of; it errs toward false, so an unnecessary compile is
  //     possible and a stale PDF presented as final is not.
  //
  // Live auto-compile-on-edit remains intentionally absent — the Compile
  // button and Cmd/Ctrl+S are the only other triggers. Guarded by
  // openedForDocRef so an in-place docId swap (route stays mounted, navigates
  // to a different doc) only runs once per docId.
  useEffect(() => {
    if (session.status !== 'authenticated' || !docLoaded) return;
    if (openedForDocRef.current === docId) return;
    openedForDocRef.current = docId;
    let cancelled = false;
    void (async () => {
      let upToDate = false;
      try {
        const latest = await api.get<LatestCompile | undefined>(
          `/docs/${encodeURIComponent(docId)}/compile/latest`,
        );
        if (cancelled) return;
        // undefined = 204, i.e. never compiled successfully. Not an error.
        if (latest?.pdf_url) {
          setPdfUrl(resolvePdfUrl(latest.pdf_url));
          // The document IS compiled and a PDF IS ready — which is what this
          // state means. Timings stay null: the duration of a compile that
          // happened in some earlier session is not ours to report, and
          // CompileLogs omits the elapsed line when either end is missing.
          setCompileState('success');
          setCompileWarnings(latest.warnings ?? []);
          upToDate = latest.is_current;
        }
      } catch {
        // 4xx/5xx/network — fall through and compile, which is what would
        // have happened before this restore existed.
      }
      if (cancelled) return;
      if (!upToDate) void triggerCompile();
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, session.status, docLoaded, triggerCompile]);

  return {
    compileState,
    compileError,
    compileWarnings,
    compileStartedAt,
    compileFinishedAt,
    pdfUrl,
    syncMap,
    triggerCompile,
  };
}
