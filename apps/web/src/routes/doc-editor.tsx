import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button, buttonClass, toastStore } from '@aeolus/shared/ui';
import { EditorSelection } from '@codemirror/state';
import * as Y from 'yjs';

import {
  EDITOR_THEME_KEY,
  editorHostBg,
  readEditorTheme,
  type EditorThemeName,
} from '../lib/editor-theme.js';
import { useAppThemeContext } from '../lib/appearance.js';

import { FileTreePanel, type ProjectFile } from '../components/FileTreePanel.js';
import { findForwardTarget } from '../lib/synctex.js';
import { fixWindowFor, type FixWindow } from '../lib/error-fix-window.js';
import { firstActionable, parseCompileLog } from '../lib/parse-compile-log.js';
import { TopBar } from '../components/TopBar.js';
import { useDocEditorKeys } from '../lib/use-doc-editor-keys.js';
// PdfPreview pulls in pdfjs-dist (~500 KB before split). Defer it
// so users on /login or /docs don't pay for it until they open the
// editor. Suspense fallback below renders a brief loading line.
const PdfPreview = lazy(() =>
  import('../components/PdfPreview.js').then((m) => ({ default: m.PdfPreview })),
);
import { CompileLogs } from '../components/CompileLogs.js';
import { HistoryPanel } from '../components/HistoryPanel.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { AiPanel, AiQuotaIndicator } from '../components/AiPanel.js';
import {
  RightPaneTabs,
  rightPanePanelProps,
  type RightPaneTab,
} from '../components/RightPaneTabs.js';
import { CommentsPanel } from '../components/CommentsPanel.js';
import { createThread, onThreadsChange, type ThreadView } from '../lib/comments.js';
import { setThreadsEffect } from '../lib/comments-decoration.js';
import { api, ApiRequestError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRouter } from '../router.js';
import { useAutoCheckpoint } from '../hooks/useAutoCheckpoint.js';
import { useCompileLifecycle } from '../hooks/useCompileLifecycle.js';
import { useDocMetadata, TITLE_MAX_LEN } from '../hooks/useDocMetadata.js';
import { useDocWsConnection } from '../hooks/useDocWsConnection.js';
import { authFailedMessage, wsStatusLabel } from '../lib/ws-labels.js';

type SidebarTab = 'files' | 'history' | 'comments' | null;

const SPLIT_KEY = 'aeolus.editor.split';
const SIDEBAR_KEY = 'aeolus.editor.sidebar';
const PDF_HIDDEN_KEY = 'aeolus.editor.pdf-hidden';

function readPersisted(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    return v ? Number(v) : fallback;
  } catch {
    return fallback;
  }
}

// Tracks viewport width via matchMedia so the toolbar can fold its
// secondary cluster into an overflow menu when there's not enough
// room for the full row. Threshold picked to match the existing
// `lg:` Tailwind breakpoint — at ≤1024px even a generous monitor
// usually can't lay out every label.
const COMPACT_TOOLBAR_QUERY = '(max-width: 1024px)';

function useCompactToolbar(): boolean {
  const [compact, setCompact] = useState<boolean>(() => {
    try {
      return window.matchMedia(COMPACT_TOOLBAR_QUERY).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(COMPACT_TOOLBAR_QUERY);
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent): void => setCompact(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return compact;
}

// Lightweight popover for the overflow toolbar. Closes on outside
// click, on Escape, and on any click inside the panel (so that
// selecting a menu item dismisses the menu without each item
// having to remember to call close).
function OverflowMenu({ children }: { children: React.ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <Button
        variant="mono"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="toolbar-overflow"
      >
        more ▾
      </Button>
      {/* The panel is a positioning box for ordinary buttons, not an ARIA
          menu (it has no menuitems and no arrow-key model), so it carries no
          role; the click handler only closes it after a child was activated. */}
      {open ? (
        <div
          id={panelId}
          role="presentation"
          className="absolute right-0 top-full z-30 mt-1 flex min-w-[12rem] flex-col items-stretch gap-1 rounded border border-hairline-strong bg-surface p-1 shadow-menu"
          data-testid="toolbar-overflow-panel"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function DocEditorRoute({ id }: { id: string }) {
  const session = useSession();
  const { navigate } = useRouter();
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  // Doc metadata + inline title-rename live in a dedicated hook so
  // the route component stays focused on layout / compose. archivedAt
  // is `null` when the doc is active and an ISO timestamp when it's
  // archived; drives both the read-only CodeMirror state and the
  // banner above the editor. Archive *toggling* happens on the
  // workspace list page, not here.
  const {
    title,
    engine,
    archivedAt,
    docLoaded,
    editingTitle,
    titleDraft,
    savingTitle,
    setTitleDraft,
    startEditingTitle,
    commitTitle,
    cancelTitle,
  } = useDocMetadata(id);
  // Compile state machine — running/success/error, the polling
  // loop, PDF url + parsed synctex map, and the one-shot
  // compile-on-open trigger — all live in useCompileLifecycle.
  // syncMap is null until a successful compile (or the synctex-
  // restore fetch on mount) populates it; drives PDF↔editor jumps.
  const {
    compileState,
    compileError,
    compileWarnings,
    compileStartedAt,
    compileFinishedAt,
    pdfUrl,
    syncMap,
    triggerCompile,
  } = useCompileLifecycle(id, docLoaded);
  // Bumped every time the user invokes "Show in PDF" so PdfPreview
  // re-runs its scroll-into-view effect even when the same page is
  // targeted twice in a row.
  const [scrollToPage, setScrollToPage] = useState<{
    page: number;
    nonce: number;
  } | null>(null);
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>('pdf');
  const [splitPct, setSplitPct] = useState(() => readPersisted(SPLIT_KEY, 50));
  // PDF preview pane visibility. When hidden, the editor takes the
  // full width (no split, no resize handle). Combined with no
  // sidebar tab open, the user gets a centered, distraction-free
  // editor surface without entering full-on focus mode.
  const [pdfHidden, setPdfHidden] = useState(() => readPersisted(PDF_HIDDEN_KEY, 0) === 1);
  // Editor theme. Solarized Dark is the default; the user picks
  // light / dark on the Settings page (writes the same localStorage
  // key). We listen for cross-tab `storage` events so a change made
  // in Settings while a doc tab is open propagates without reload.
  // Same-tab navigation already remounts the editor, so a fresh
  // read at mount covers in-tab transitions.
  const [editorThemeName, setEditorThemeName] = useState<EditorThemeName>(readEditorTheme);
  // The app's resolved polarity. `auto` above means "whatever this is".
  const { isDark: appIsDark } = useAppThemeContext();
  const compactToolbar = useCompactToolbar();
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === EDITOR_THEME_KEY) setEditorThemeName(readEditorTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() =>
    readPersisted(SIDEBAR_KEY, 0) === 1 ? 'files' : null,
  );
  const [previewCheckpoint, setPreviewCheckpoint] = useState<{
    id: string;
    label: string;
    content: string;
  } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  // Focus mode hides every chrome element (TopBar, secondary header,
  // sidebars, right pane, status bar) leaving only the editor and a
  // small Esc pill. Toggled via Cmd/Ctrl + . or the Exit pill;
  // intentionally not persisted (a stuck toggle is a footgun).
  const [focusMode, setFocusMode] = useState(false);
  // Currently-open text file. null means "the project's main
  // entrypoint" — the ws upgrade resolves this to main.{tex,typ}'s
  // yjs_doc_id when no fileId is supplied. Switching files tears
  // down + rebuilds the WebsocketProvider on the new yjs_doc_id;
  // editor cursor / awareness reset to the loaded state of the
  // selected file. (Per-file Yjs persistence: ADR 0013.)
  const [currentFile, setCurrentFile] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [aiRequest, setAiRequest] = useState<{
    selection: string;
    instruction: string;
    errorContext?: string;
    // Error-fix scope (#57): the line window the selection covers, or
    // null when the log named no line and the whole source was sent.
    // Undefined for plain rewrites.
    fixWindow?: FixWindow | null;
  } | null>(null);
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const [openCommentCount, setOpenCommentCount] = useState(0);
  // A new-comment composer in flight: the editor range and preview
  // captured when "+ comment" was pressed. CommentsPanel renders the
  // form; submit creates the thread against this range. Held as one
  // state object so the panel's per-composer reset effect sees a
  // stable reference across unrelated host re-renders.
  const [commentDraft, setCommentDraft] = useState<{
    from: number;
    to: number;
    preview: string;
  } | null>(null);
  const resizingRef = useRef(false);
  // Detaches the document-level mousemove/mouseup listeners a split
  // drag installs, so an unmount mid-drag does not leave them behind.
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // y-websocket + Y.Doc + EditorView lifecycle. ydoc re-mounts on
  // docId / currentFile / archive / theme changes; the route reads
  // it for child subscriptions (CommentsPanel) and uses
  // editorViewRef in selection-aware handlers.
  const { ydoc, wsStatus, authFailed, editorViewRef } = useDocWsConnection({
    docId: id,
    currentFileId: currentFile?.id ?? null,
    archivedAt,
    docLoaded,
    editorThemeName,
    appIsDark,
    editorHostRef,
  });

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    }
  }, [session, navigate]);

  // A composer belongs to the Y.Doc it was opened on; switching files
  // (a new ydoc) discards it rather than anchoring into the wrong text.
  useEffect(() => {
    setCommentDraft(null);
  }, [ydoc]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useAutoCheckpoint(id, currentFile?.id ?? null, archivedAt, docLoaded);

  // Auto-switch the right pane to match the compile outcome: logs on
  // failure (timeout, server-reported 'failed', or network error) so the user
  // sees what broke, and back to the PDF on success so the freshly rendered
  // output shows without hunting for a button. Without the success→pdf leg, a
  // prior failure (e.g. compile-on-open on a still-empty new doc) leaves the
  // pane stuck on 'logs', so PdfPreview never mounts even once a later compile
  // succeeds — the PDF silently never appears. The hook stays UI-agnostic;
  // this observer is the only piece that knows about rightPaneTab.
  useEffect(() => {
    if (compileState === 'error') setRightPaneTab('logs');
    else if (compileState === 'success') setRightPaneTab('pdf');
  }, [compileState]);

  const handleAiSubmit = useCallback(
    (instruction: string) => {
      const view = editorViewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      // No selection → operate on the whole document. Force-select
      // it now so handleAiAccept's range-replace below actually
      // applies the response (otherwise Accept silently no-ops on
      // a zero-width selection). Mirrors the same trick the error-
      // fix path uses.
      let selection: string;
      if (from === to) {
        selection = view.state.doc.toString();
        view.dispatch({
          selection: { anchor: 0, head: view.state.doc.length },
        });
      } else {
        selection = view.state.sliceDoc(from, to);
      }
      setAiRequest({ selection, instruction });
    },
    [editorViewRef],
  );

  // "Ask Claude to fix" handler (#57). Parses the source line out of
  // the compile log (Tectonic `l.N`, Typst `main.typ:N:C`) and selects
  // a bounded window of whole paragraphs around it — that excerpt, not
  // the whole document, is what Claude sees and what Accept replaces
  // (handleAiAccept replaces the current selection). Only when the log
  // names no line does it fall back to the full source, and the panel
  // says so.
  const handleAskClaude = useCallback(
    (errorText: string) => {
      const view = editorViewRef.current;
      if (!view) return;
      const source = view.state.doc.toString();
      if (!source.trim()) return;

      const target = firstActionable(parseCompileLog(errorText));
      const fixWindow = fixWindowFor(source, target?.line ?? null);

      if (fixWindow) {
        const from = view.state.doc.line(fixWindow.fromLine).from;
        const to = view.state.doc.line(fixWindow.toLine).to;
        view.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
        });
        setAiRequest({
          selection: view.state.sliceDoc(from, to),
          instruction:
            `Fix the compile error in this excerpt (lines ${fixWindow.fromLine}-${fixWindow.toLine} of a ` +
            `${fixWindow.totalLines}-line document). Change only what the error requires. Return only the ` +
            'corrected excerpt, covering exactly the same lines — no explanation, no markdown fences, no ' +
            'text from outside the excerpt.',
          errorContext: errorText,
          fixWindow,
        });
        return;
      }

      view.dispatch({
        selection: { anchor: 0, head: view.state.doc.length },
      });
      setAiRequest({
        selection: source,
        instruction:
          'Fix this compile error. Change only what the error requires. Return only the corrected source — no explanation, no markdown fences.',
        errorContext: errorText,
        fixWindow: null,
      });
    },
    [editorViewRef],
  );

  // Push thread updates into the editor's decoration set. Subscribes
  // to the live Y.Doc so the inline underline marks stay in sync as
  // collaborators add / resolve comments.
  useEffect(() => {
    if (!ydoc) return;
    const stop = onThreadsChange(ydoc, (threads: ThreadView[]) => {
      const view = editorViewRef.current;
      if (view) {
        view.dispatch({ effects: setThreadsEffect.of(threads) });
      }
      setOpenCommentCount(threads.filter((t) => !t.resolved).length);
    });
    return stop;
  }, [ydoc, editorViewRef]);

  // Start a thread from the current editor selection: capture the
  // range now (focus moves to the composer, which would clear it),
  // open the comments sidebar and let CommentsPanel collect the body.
  // No-op if the selection is empty or the Y.Doc isn't loaded yet.
  // This used to be window.prompt, which browsers block when the app
  // is framed inside the portal.
  const handleCreateComment = useCallback(() => {
    const view = editorViewRef.current;
    if (!view || !ydoc) return;
    const sel = view.state.selection.main;
    if (sel.from === sel.to) {
      toastStore.push({
        kind: 'info',
        message: 'Select some text in the editor before adding a comment.',
      });
      return;
    }
    setCommentDraft({
      from: sel.from,
      to: sel.to,
      preview: view.state.sliceDoc(sel.from, sel.to).slice(0, 200),
    });
    setSidebarTab('comments');
    try {
      localStorage.setItem(SIDEBAR_KEY, '1');
    } catch {
      /* ignore */
    }
  }, [ydoc, editorViewRef]);

  const handleCommentSubmit = useCallback(
    (body: string) => {
      if (!ydoc || !commentDraft || session.status !== 'authenticated') return;
      createThread(ydoc, {
        from: commentDraft.from,
        to: commentDraft.to,
        body,
        authorId: session.user.id,
        authorName: session.user.name ?? session.user.email,
        preview: commentDraft.preview,
      });
      setCommentDraft(null);
    },
    [ydoc, commentDraft, session],
  );

  // Jump to a thread's anchored range. Called from CommentsPanel
  // when the user clicks a thread row.
  const handleCommentJump = useCallback(
    (from: number, to: number) => {
      const view = editorViewRef.current;
      if (!view) return;
      const total = view.state.doc.length;
      const fromClamped = Math.max(0, Math.min(from, total));
      const toClamped = Math.max(fromClamped, Math.min(to, total));
      view.dispatch({
        selection: EditorSelection.range(fromClamped, toClamped),
        scrollIntoView: true,
      });
      view.focus();
    },
    [editorViewRef],
  );

  // Forward synctex jump: from the editor's current line to the PDF
  // page containing it. Triggered by the "Show in PDF" button (and
  // the keybinding wired via use-doc-editor-keys). No-op when the
  // last compile didn't produce a sync map.
  const handleShowInPdf = useCallback(() => {
    const view = editorViewRef.current;
    if (!view || !syncMap) return;
    const cursor = view.state.selection.main.head;
    const lineNum = view.state.doc.lineAt(cursor).number;
    // Resolve the file via the currently-open file path; defaults to
    // main.{tex,typ} when the user hasn't picked anything else.
    const file = currentFile?.path ?? (engine === 'typst' ? 'main.typ' : 'main.tex');
    const box = findForwardTarget(syncMap, file, lineNum);
    if (!box) return;
    setRightPaneTab('pdf');
    setScrollToPage({ page: box.page, nonce: Date.now() });
  }, [syncMap, currentFile, engine, editorViewRef]);

  // Reverse synctex jump: from a PDF click. PdfPreview computes the
  // closest synctex box on the clicked page and calls back here.
  // Clamps to the doc length and switches files when the synctex
  // box belongs to a different one (multi-file projects).
  const handleSourceJump = useCallback(
    (file: string, line: number) => {
      // Switching the open text file requires a WS reopen on a new
      // yjs_doc_id, which is async. For v1 we only honour clicks
      // that resolve to the currently-open file; cross-file reverse
      // jumps land separately once the file-tree integration plumbs
      // a path-to-file lookup.
      const currentPath = currentFile?.path ?? (engine === 'typst' ? 'main.typ' : 'main.tex');
      if (file !== currentPath && !currentPath.endsWith(file) && !file.endsWith(currentPath)) {
        return;
      }
      const view = editorViewRef.current;
      if (!view) return;
      const total = view.state.doc.lines;
      const clamped = Math.max(1, Math.min(line, total));
      const pos = view.state.doc.line(clamped).from;
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        scrollIntoView: true,
      });
      view.focus();
    },
    [currentFile, engine, editorViewRef],
  );

  // Compile-error jump-to-line. Called by CompileLogs when the
  // user clicks the first-error card or a list row. Clamps line
  // numbers to the doc range so a stale parse doesn't crash with
  // RangeError, and exits focus mode is irrelevant — staying in
  // focus mode while jumping is the explicit request.
  const handleJumpToLine = useCallback(
    (line: number) => {
      const view = editorViewRef.current;
      if (!view || !Number.isFinite(line) || line < 1) return;
      const total = view.state.doc.lines;
      const clamped = Math.min(line, total);
      const pos = view.state.doc.line(clamped).from;
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        scrollIntoView: true,
      });
      view.focus();
    },
    [editorViewRef],
  );

  const handleAiAccept = useCallback(
    (text: string) => {
      const view = editorViewRef.current;
      if (!view) {
        setAiRequest(null);
        return;
      }
      const { from, to } = view.state.selection.main;
      if (from !== to) {
        view.dispatch({ changes: { from, to, insert: text } });
      }
      setAiRequest(null);
    },
    [editorViewRef],
  );

  // Window-level keybindings. Registered after the editor handlers
  // are defined so the synctex jump can be passed in directly.
  useDocEditorKeys({
    focusMode,
    setFocusMode,
    setCmdPaletteOpen,
    triggerCompile,
    editorViewRef,
    onShowInPdf: handleShowInPdf,
  });

  // Clamp to 20–80% and persist. Shared by the mouse drag and the
  // separator's arrow keys.
  const applySplit = useCallback((pct: number) => {
    const clamped = Math.max(20, Math.min(80, pct));
    setSplitPct(clamped);
    try {
      localStorage.setItem(SPLIT_KEY, String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const handleResizeStart = useCallback(() => {
    resizingRef.current = true;
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const container = document.getElementById('editor-split-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      applySplit(((e.clientX - rect.left) / rect.width) * 100);
    };
    const stop = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', stop);
      if (resizeCleanupRef.current === stop) resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = stop;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', stop);
  }, [applySplit]);

  const openSidebar = useCallback((tab: SidebarTab) => {
    setSidebarTab((prev) => {
      const next = prev === tab ? null : tab;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const handlePreviewCheckpoint = useCallback(
    async (_checkpointId: string, label: string, downloadUrl: string) => {
      try {
        const bytes = await api.getBytes(downloadUrl);
        const previewDoc = new Y.Doc();
        Y.applyUpdate(previewDoc, bytes);
        const content = previewDoc.getText('source').toString();
        previewDoc.destroy();
        setPreviewCheckpoint({ id: _checkpointId, label, content });
        setConfirmRestore(false);
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to load checkpoint',
        });
      }
    },
    [],
  );

  const handleRestore = useCallback(async () => {
    if (!previewCheckpoint) return;
    setRestoring(true);
    try {
      await api.post(
        `/docs/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(previewCheckpoint.id)}/restore`,
      );
      toastStore.push({ kind: 'success', message: 'Checkpoint restored' });
      setPreviewCheckpoint(null);
      setConfirmRestore(false);
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Restore failed',
      });
    } finally {
      setRestoring(false);
    }
  }, [id, previewCheckpoint]);

  if (session.status !== 'authenticated') {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <div className="flex h-screen flex-col" data-focus-mode={focusMode || undefined}>
      {!focusMode && <TopBar user={session.user} />}
      {!focusMode && authFailed ? (
        <div
          className="flex items-center justify-between gap-4 border-b border-accent-border bg-accent-bg-alt px-8 py-3 text-sm text-accent-fg-strong"
          data-testid="ws-auth-failed-banner"
        >
          <div>
            <strong className="font-semibold">Editor connection rejected.</strong>{' '}
            {authFailedMessage(authFailed.reason)} Your typing is no longer reaching the server.
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="shrink-0 rounded bg-btn-primary px-3 py-1.5 font-mono text-[12px] uppercase tracking-wider text-btn-primary-fg hover:bg-btn-primary-hover"
          >
            Reload
          </button>
        </div>
      ) : null}
      {!focusMode && (
        <div className="flex items-center justify-between gap-6 border-b border-hairline-strong bg-surface px-6 py-2.5 print:hidden">
          <div className="flex min-w-0 items-center gap-3">
            {editingTitle ? (
              <input
                autoFocus
                type="text"
                value={titleDraft}
                maxLength={TITLE_MAX_LEN}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitTitle();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelTitle();
                  }
                }}
                disabled={savingTitle}
                aria-label="Document title"
                data-testid="doc-title-input"
                className="rounded border border-hairline-strong bg-surface px-2 py-0.5 text-[15px] font-semibold text-body focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            ) : (
              <h1
                className="-mx-1 min-w-0 truncate text-[15px] font-semibold tracking-tight text-body"
                data-testid="doc-title"
              >
                {/* The clickable part is a real button (keyboard-reachable,
                    announced as a control) rather than an onClick on the
                    heading. The label keeps the title so the heading still
                    names the document. */}
                <button
                  type="button"
                  aria-label={title === null ? 'Rename document' : `Rename document: ${title}`}
                  title="Click to rename"
                  onClick={startEditingTitle}
                  disabled={title === null}
                  data-testid="doc-title-rename"
                  className="max-w-full cursor-text truncate rounded px-1 text-left hover:bg-fill-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default disabled:hover:bg-transparent"
                >
                  {title ?? 'Loading…'}
                </button>
              </h1>
            )}
            <span className="shrink-0 rounded-badge bg-fill-warm px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-body-2">
              {engine}
            </span>
            {currentFile ? (
              <span
                className="hidden shrink-0 truncate font-mono text-[11px] text-muted lg:inline"
                data-testid="current-file-path"
                title="Editing this file"
              >
                · {currentFile.path}
              </span>
            ) : null}
            <span
              data-testid="ws-status"
              className={`hidden shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest md:inline-flex ${
                wsStatus === 'connected'
                  ? 'text-success-fg'
                  : wsStatus === 'error'
                    ? 'text-accent-text'
                    : 'text-muted'
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  wsStatus === 'connected'
                    ? 'bg-success-edge'
                    : wsStatus === 'error'
                      ? 'bg-danger-edge'
                      : 'animate-pulse bg-hairline-strong'
                }`}
                aria-hidden
              />
              {wsStatusLabel(wsStatus)}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="mono" onClick={() => openSidebar('files')} data-testid="files-toggle">
              {sidebarTab === 'files' ? 'files ✓' : 'files'}
            </Button>
            <Button
              variant="mono"
              onClick={() => openSidebar('history')}
              data-testid="history-toggle"
            >
              {sidebarTab === 'history' ? 'history ✓' : 'history'}
            </Button>
            <Button
              variant="mono"
              onClick={() => openSidebar('comments')}
              data-testid="comments-toggle"
            >
              {sidebarTab === 'comments'
                ? 'comments ✓'
                : openCommentCount > 0
                  ? `comments · ${openCommentCount}`
                  : 'comments'}
            </Button>
            <span className="mx-2 h-4 w-px bg-hairline-strong" aria-hidden />
            {/* Secondary cluster — folded into a `more ▾` overflow
              menu at narrow widths. Same buttons either way; the
              parent decides layout. The {secondaryDivider} marker
              renders as a separator only in the wide layout. */}
            {(() => {
              const secondaryItems = (
                <>
                  <Button
                    variant="mono"
                    onClick={handleCreateComment}
                    data-testid="comment-add-btn"
                    title="Add a comment on the current selection"
                  >
                    + comment
                  </Button>
                  <Button
                    variant="mono"
                    onClick={() => setCmdPaletteOpen(true)}
                    data-testid="ai-btn"
                    title="Claude (⌘K)"
                  >
                    claude
                  </Button>
                  {syncMap ? (
                    <Button
                      variant="mono"
                      onClick={handleShowInPdf}
                      data-testid="show-in-pdf-btn"
                      title="Jump from cursor to the matching PDF page (⌘J)"
                    >
                      show in pdf
                    </Button>
                  ) : null}
                  <Button
                    variant="mono"
                    onClick={() => {
                      setPdfHidden((prev) => {
                        const next = !prev;
                        try {
                          localStorage.setItem(PDF_HIDDEN_KEY, next ? '1' : '0');
                        } catch {
                          /* ignore */
                        }
                        return next;
                      });
                    }}
                    data-testid="pdf-toggle"
                    title={pdfHidden ? 'Show the PDF preview pane' : 'Hide the PDF preview pane'}
                  >
                    {pdfHidden ? 'pdf' : 'pdf ✓'}
                  </Button>
                  {/* Focus mode had no way in. setFocusMode(true) was
                    reachable only from the ⌘. keybinding, and nothing in
                    the UI mentions that shortcut, so the feature was
                    invisible to anyone who had not read the source. The
                    exit affordance already existed (the button rendered
                    while focusMode is on), which is what hid the gap. */}
                  <Button
                    variant="mono"
                    onClick={() => setFocusMode(true)}
                    data-testid="focus-mode-enter"
                    title="Hide every panel and write full-screen (⌘.) — Esc to leave"
                  >
                    focus
                  </Button>
                  {/* Same-origin <a download> hits the streaming PDF
                    endpoint with the session cookie; the server
                    emits Content-Disposition: attachment so the
                    browser saves rather than navigates. Disabled-
                    look styling when no PDF is built yet. */}
                  <a
                    href={pdfUrl ?? '#'}
                    download={`${title || 'document'}.pdf`}
                    data-testid="download-pdf-btn"
                    aria-disabled={pdfUrl === null}
                    tabIndex={pdfUrl === null ? -1 : 0}
                    title="Download the compiled PDF"
                    className={buttonClass(
                      'mono',
                      'md',
                      pdfUrl === null ? 'pointer-events-none opacity-40' : '',
                    )}
                    onClick={(e) => {
                      if (pdfUrl === null) e.preventDefault();
                    }}
                  >
                    ↓ pdf
                  </a>
                  <a
                    href={`/api/docs/${encodeURIComponent(id)}/download.zip`}
                    download={`${title || 'project'}.zip`}
                    data-testid="download-zip-btn"
                    title="Download every file in the project as a zip"
                    className={buttonClass('mono')}
                  >
                    ↓ zip
                  </a>
                </>
              );
              return compactToolbar ? (
                <OverflowMenu>{secondaryItems}</OverflowMenu>
              ) : (
                secondaryItems
              );
            })()}
            <span className="mx-2 h-4 w-px bg-hairline-strong" aria-hidden />
            <Button
              variant="primary"
              disabled={compileState === 'running'}
              onClick={() => void triggerCompile()}
              data-testid="compile-btn"
            >
              {compileState === 'running' ? 'Compiling…' : 'Compile'}
            </Button>
          </div>
        </div>
      )}
      {archivedAt && !focusMode ? (
        <div
          className="border-b border-hairline-strong bg-fill-warm px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-body-2"
          data-testid="archived-banner"
        >
          // archived · read only · compile and download still work
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        {!focusMode && sidebarTab === 'files' && (
          <div className="relative w-72 flex-shrink-0">
            <FileTreePanel
              docId={id}
              canWrite={true}
              selectedFileId={currentFile?.id ?? null}
              onSelectFile={(file: ProjectFile) => setCurrentFile({ id: file.id, path: file.path })}
            />
          </div>
        )}
        {!focusMode && sidebarTab === 'history' && (
          <div className="relative w-72 flex-shrink-0">
            <HistoryPanel
              docId={id}
              canWrite={true}
              currentFile={currentFile}
              onPreview={handlePreviewCheckpoint}
            />
          </div>
        )}
        {!focusMode && sidebarTab === 'comments' && (
          <div className="relative w-72 flex-shrink-0">
            <CommentsPanel
              ydoc={ydoc}
              userId={session.status === 'authenticated' ? session.user.id : 'anonymous'}
              userName={
                session.status === 'authenticated'
                  ? (session.user.name ?? session.user.email)
                  : null
              }
              canWrite={wsStatus === 'connected'}
              onJump={handleCommentJump}
              showResolved={showResolvedComments}
              setShowResolved={setShowResolvedComments}
              composer={commentDraft}
              onComposerSubmit={handleCommentSubmit}
              onComposerCancel={() => setCommentDraft(null)}
            />
          </div>
        )}
        <div id="editor-split-container" className="flex flex-1 overflow-hidden">
          <div
            ref={editorHostRef}
            data-testid="editor-host"
            className="overflow-hidden"
            // Editor expands to fill the row when the PDF pane is
            // hidden or focus mode is on; otherwise it takes the
            // user-controlled split percentage. Background colour
            // mirrors the active theme so there's no flash before
            // CodeMirror paints.
            style={{
              width: focusMode || pdfHidden ? '100%' : `${splitPct}%`,
              backgroundColor: editorHostBg(editorThemeName, appIsDark),
            }}
          />
          {!focusMode && !pdfHidden && (
            // role="slider", not "separator": the handle is focusable and
            // arrow keys change a value between a min and a max, which is a
            // slider's contract. ARIA's focusable separator describes the
            // same widget, but assistive tech and the a11y lint both treat
            // separator as static.
            <div
              role="slider"
              aria-orientation="vertical"
              aria-label="Resize editor and preview"
              aria-valuenow={Math.round(splitPct)}
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuetext={`Editor ${Math.round(splitPct)} percent`}
              tabIndex={0}
              className="w-1 flex-shrink-0 cursor-col-resize bg-hairline-strong hover:bg-focus focus:outline-none focus-visible:bg-focus focus-visible:ring-2 focus-visible:ring-focus"
              onMouseDown={handleResizeStart}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  applySplit(splitPct - 2);
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  applySplit(splitPct + 2);
                }
              }}
              data-testid="split-handle"
            />
          )}
          {!focusMode && aiRequest && (
            <div className="w-80 flex-shrink-0">
              <AiPanel
                docId={id}
                selection={aiRequest.selection}
                instruction={aiRequest.instruction}
                errorContext={aiRequest.errorContext}
                fixWindow={aiRequest.fixWindow}
                onAccept={handleAiAccept}
                onDismiss={() => setAiRequest(null)}
              />
            </div>
          )}
          {!focusMode && !pdfHidden && (
            <div className="overflow-hidden" style={{ width: `${100 - splitPct}%` }}>
              {previewCheckpoint ? (
                <div className="flex h-full flex-col" data-testid="checkpoint-preview">
                  <div className="flex items-center justify-between border-b border-hairline-strong bg-page px-4 py-2">
                    <span className="text-xs font-semibold text-body-2">
                      Preview: {previewCheckpoint.label}
                    </span>
                    <div className="flex gap-2">
                      {!confirmRestore ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => setConfirmRestore(true)}
                          data-testid="checkpoint-restore-btn"
                        >
                          Restore
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmRestore(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={restoring}
                            onClick={() => void handleRestore()}
                            data-testid="checkpoint-restore-confirm"
                          >
                            {restoring ? 'Restoring…' : 'Confirm restore'}
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setPreviewCheckpoint(null);
                          setConfirmRestore(false);
                        }}
                        data-testid="checkpoint-preview-close"
                      >
                        Close
                      </Button>
                    </div>
                  </div>
                  <pre className="flex-1 overflow-auto whitespace-pre-wrap bg-page p-4 font-mono text-xs text-body-2">
                    {previewCheckpoint.content}
                  </pre>
                </div>
              ) : (
                <div className="flex h-full flex-col">
                  <RightPaneTabs
                    active={rightPaneTab}
                    onChange={setRightPaneTab}
                    logsBadge={
                      compileState === 'error' ? (
                        <span
                          className="rounded-badge bg-accent-bg px-1.5 font-mono text-[10px] text-accent-text"
                          aria-label="Compile failed"
                        >
                          !
                        </span>
                      ) : compileWarnings.length > 0 ? (
                        <span
                          className="rounded-badge bg-warning-bg px-1.5 font-mono text-[10px] text-warning-fg-strong"
                          aria-label={`${compileWarnings.length} compile warning${compileWarnings.length === 1 ? '' : 's'}`}
                          title="The PDF compiled, but read the warnings before sending it"
                          data-testid="compile-warnings-badge"
                        >
                          {compileWarnings.length}
                        </span>
                      ) : null
                    }
                  />
                  <div className="flex-1 overflow-hidden" {...rightPanePanelProps(rightPaneTab)}>
                    {rightPaneTab === 'pdf' ? (
                      <Suspense
                        fallback={
                          <div className="flex h-full items-center justify-center text-sm text-muted">
                            Loading PDF viewer…
                          </div>
                        }
                      >
                        <PdfPreview
                          url={pdfUrl}
                          syncMap={syncMap}
                          scrollToPage={scrollToPage?.page ?? null}
                          onSourceJump={handleSourceJump}
                        />
                      </Suspense>
                    ) : (
                      <CompileLogs
                        state={compileState}
                        error={compileError}
                        warnings={compileWarnings}
                        startedAt={compileStartedAt}
                        finishedAt={compileFinishedAt}
                        onJumpToLine={handleJumpToLine}
                        onAskClaude={handleAskClaude}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {!focusMode && (
        <div
          className="flex h-7 items-center justify-between border-t border-hairline-strong bg-page px-4 font-mono text-[11px] print:hidden"
          data-testid="status-bar"
        >
          <span
            className={`flex items-center gap-2 tracking-wider ${
              compileState === 'running'
                ? 'text-muted'
                : compileState === 'success'
                  ? 'text-success-fg'
                  : compileState === 'error'
                    ? 'text-accent-text'
                    : 'text-muted'
            }`}
            data-testid="compile-status"
          >
            <span className="text-placeholder">›</span>
            {compileState === 'idle' && 'ready'}
            {compileState === 'running' && 'compiling…'}
            {compileState === 'success' && 'compiled · pdf ready'}
            {compileState === 'error' && (compileError ?? 'compile failed')}
          </span>
          <AiQuotaIndicator />
        </div>
      )}

      {focusMode && (
        <button
          type="button"
          onClick={() => setFocusMode(false)}
          data-testid="focus-mode-exit"
          className="fixed bottom-5 right-5 z-40 rounded border border-inverse-border bg-inverse px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-inverse-fg shadow-dialog transition-colors hover:bg-inverse-hover"
        >
          exit focus
          <kbd className="ml-2 rounded-badge bg-inverse-hover px-1.5 py-0.5 font-mono text-[10px] text-inverse-fg">
            Esc
          </kbd>
        </button>
      )}

      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onSubmit={handleAiSubmit}
      />
    </div>
  );
}
