import { useEffect, useRef, useState } from 'react';

import { Button } from '@aeolus/shared/ui';
import type { AiAssistEvent, AiQuotaResponse } from '@aeolus/shared';

import { api, reportUnauthenticated } from '../lib/api.js';
import { describeFixWindow, type FixWindow } from '../lib/error-fix-window.js';

interface Props {
  docId: string;
  selection: string;
  instruction: string;
  // When set, the request becomes a "fix this compile error" call
  // — the api weaves the stderr into the user message and Claude
  // returns a corrected source that should replace the selection.
  errorContext?: string;
  // Error-fix scope (#57): the line window the selection covers; null
  // when the whole document had to be sent. Rendered so the reader
  // knows what Accept will replace before they click it.
  fixWindow?: FixWindow | null;
  onAccept: (text: string) => void;
  onDismiss: () => void;
}

export function AiPanel({
  docId,
  selection,
  instruction,
  errorContext,
  fixWindow,
  onAccept,
  onDismiss,
}: Props) {
  const [responseText, setResponseText] = useState('');
  const [status, setStatus] = useState<'streaming' | 'done' | 'error'>('streaming');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Higher-quality opt-in for the error-fix path. The server picks the
  // actual model for each tier, so nothing here names one. Off by
  // default so routine rewrites stay cheap; toggling re-issues the
  // request.
  const [preferHigherQuality, setPreferHigherQuality] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Streaming buffer + pending RAF handle. Each SSE chunk used to
  // call setResponseText(prev => prev + chunk) directly, which forced
  // a React render + DOM diff per chunk — hundreds of renders per
  // multi-thousand-token response. Buffering into a ref and flushing
  // once per animation frame keeps the visible text identical while
  // collapsing the render storm.
  const bufferRef = useRef('');
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    // Reset the panel state for each new (re)issue.
    setResponseText('');
    setErrorMsg(null);
    setStatus('streaming');
    bufferRef.current = '';
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // End-of-stream transition. Written as a functional update because
    // the closure's `status` is the value from the render that started
    // the stream — always 'streaming' — so `if (status === 'streaming')
    // setStatus('done')` used to overwrite an `error` event received
    // mid-stream, hiding the failure and enabling Accept.
    const settle = (prev: 'streaming' | 'done' | 'error'): 'streaming' | 'done' | 'error' =>
      prev === 'error' ? prev : 'done';

    const scheduleFlush = (): void => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setResponseText(bufferRef.current);
      });
    };
    const flushNow = (): void => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setResponseText(bufferRef.current);
    };

    void (async () => {
      try {
        const res = await fetch('/api/ai/assist', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            docId,
            selection,
            instruction,
            ...(errorContext ? { errorContext } : {}),
            ...(preferHigherQuality ? { preferHigherQuality: true } : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Raw fetch (SSE cannot go through `api`), so the global
          // 401 → /login hook has to be invoked by hand here.
          if (res.status === 401) reportUnauthenticated();
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setErrorMsg(body.message ?? 'The request could not be completed.');
          setStatus('error');
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          setErrorMsg('No response body');
          setStatus('error');
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        // Lives across reads: an `event:` line and its `data:` line can
        // arrive in different network chunks, and resetting this per
        // read() dropped the data line's event (so the chunk was lost).
        let currentEvent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7);
            } else if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6)) as AiAssistEvent;
              if (currentEvent === 'chunk' && data.text) {
                bufferRef.current += data.text;
                scheduleFlush();
              } else if (currentEvent === 'error') {
                flushNow();
                setErrorMsg(data.error ?? 'Unknown error');
                setStatus('error');
              } else if (currentEvent === 'done') {
                flushNow();
                setStatus(settle);
              }
            }
          }
        }

        flushNow();
        setStatus(settle);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          flushNow();
          setErrorMsg((err as Error).message);
          setStatus('error');
        }
      }
    })();

    return () => {
      controller.abort();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [docId, selection, instruction, errorContext, preferHigherQuality, retryNonce]);

  return (
    <div
      className="flex h-full flex-col border-l border-hairline-strong bg-surface"
      data-testid="ai-panel"
    >
      <div className="flex items-center justify-between border-b border-hairline-strong px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-body-2">Claude</span>
          {preferHigherQuality ? (
            <span
              className="rounded-badge bg-fill-warm px-1.5 py-0.5 font-mono text-[10px] text-body-2"
              data-testid="ai-quality-badge"
            >
              higher quality
            </span>
          ) : null}
        </div>
        <div className="flex gap-2">
          {status === 'done' && responseText && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onAccept(responseText)}
              data-testid="ai-accept"
            >
              Accept
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDismiss} data-testid="ai-dismiss">
            Dismiss
          </Button>
        </div>
      </div>
      {errorContext && fixWindow !== undefined ? (
        <div
          className="border-b border-hairline bg-page px-4 py-1 font-mono text-[11px] text-muted"
          data-testid="ai-scope"
        >
          {describeFixWindow(fixWindow)}
        </div>
      ) : null}
      {errorContext ? (
        <div className="flex items-center gap-2 border-b border-hairline bg-page px-4 py-1.5">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-body-2">
            <input
              type="checkbox"
              checked={preferHigherQuality}
              onChange={(e) => setPreferHigherQuality(e.target.checked)}
              data-testid="ai-prefer-higher-quality"
              disabled={status === 'streaming'}
            />
            <span>Use the higher-quality model</span>
          </label>
          {status === 'done' || status === 'error' ? (
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              data-testid="ai-retry"
              className="ml-auto text-[11px] text-muted underline-offset-2 hover:text-body-2 hover:underline"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex-1 overflow-auto p-4">
        {status === 'error' ? (
          <p className="text-xs text-accent-text" data-testid="ai-error">
            {errorMsg}
          </p>
        ) : (
          <pre
            className="whitespace-pre-wrap font-mono text-xs text-body-2"
            data-testid="ai-response"
            aria-live="polite"
          >
            {responseText}
            {status === 'streaming' && <span className="animate-pulse text-muted">|</span>}
          </pre>
        )}
      </div>
    </div>
  );
}

export function AiQuotaIndicator() {
  const [quota, setQuota] = useState<AiQuotaResponse | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setQuota(await api.get<AiQuotaResponse>('/ai/quota'));
      } catch {
        // Quota indicator is non-critical
      }
    })();
  }, []);

  if (!quota) return null;

  const hourlyPct = Math.round((quota.hourly.used / quota.hourly.limit) * 100);
  const color =
    hourlyPct >= 90 ? 'text-accent-text' : hourlyPct >= 70 ? 'text-warning-fg' : 'text-muted';
  const remaining = quota.hourly.limit - quota.hourly.used;

  return (
    <span
      className={`text-xs ${color}`}
      data-testid="ai-quota"
      title={`Claude requests left this hour. Everyone shares an allowance of ${quota.hourly.limit} an hour, and it refills as the hour rolls over.`}
    >
      Claude: {remaining} of {quota.hourly.limit} this hour
    </span>
  );
}
