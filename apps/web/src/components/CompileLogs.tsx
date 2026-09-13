import { useMemo, useState } from 'react';

import { Button, toastStore } from '@aeolus/shared/ui';

import { copyToClipboard } from '../lib/clipboard.js';
import { firstActionable, parseCompileLog } from '../lib/parse-compile-log.js';

type CompileState = 'idle' | 'running' | 'success' | 'error';

interface CompileLogsProps {
  state: CompileState;
  error: string | null;
  // Non-fatal findings on a successful compile (#80): fonts the PDF
  // references but does not embed. Shown even when the compile passed,
  // because the previewer masks exactly this class of problem.
  warnings?: string[];
  startedAt: number | null;
  finishedAt: number | null;
  // When provided, the first-error card and the per-entry list rows
  // become clickable and call this with the source line. The host
  // (doc-editor.tsx) wires it to EditorView.dispatch so the cursor
  // jumps and the line scrolls into view.
  onJumpToLine?: (line: number) => void;
  // When provided and the compile is in 'error' state, a "Ask Claude
  // to fix" button shows in the header and invokes this with the
  // raw stderr. The host (doc-editor.tsx) bundles current source +
  // error and opens AiPanel in error-fix mode.
  onAskClaude?: (errorText: string) => void;
}

// Best-effort split of a Tectonic / Typst stderr tail into "blocks"
// the user can scan. Tectonic prints `! LaTeX Error: ...` followed
// by a few lines of context; Typst prints `error: ...` headers.
// We don't try to fully parse the log — Overleaf's parser is rich,
// ours is just enough to make the first error stand out.
interface LogBlock {
  kind: 'error' | 'warning' | 'info';
  text: string;
}

function classifyLine(line: string): LogBlock['kind'] {
  if (/^\s*(!|error\s*:|fatal:|\? l\.\d+)/i.test(line)) return 'error';
  if (/^\s*(warning|over(full|underfull))/i.test(line)) return 'warning';
  return 'info';
}

function splitIntoBlocks(text: string): LogBlock[] {
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const blocks: LogBlock[] = [];
  let current: LogBlock | null = null;
  for (const line of lines) {
    const kind = classifyLine(line);
    if (kind !== 'info' || current === null) {
      if (current) blocks.push(current);
      current = { kind, text: line };
    } else {
      current.text += `\n${line}`;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function formatDuration(startedAt: number | null, finishedAt: number | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const ms = finishedAt - startedAt;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function CompileLogs({
  state,
  error,
  warnings = [],
  startedAt,
  finishedAt,
  onJumpToLine,
  onAskClaude,
}: CompileLogsProps) {
  const blocks = useMemo(() => splitIntoBlocks(error ?? ''), [error]);
  const parsed = useMemo(() => parseCompileLog(error), [error]);
  const top = useMemo(() => firstActionable(parsed), [parsed]);
  const [showRaw, setShowRaw] = useState(false);
  const errorCount = blocks.filter((b) => b.kind === 'error').length;
  const warningCount = blocks.filter((b) => b.kind === 'warning').length + warnings.length;
  const duration = formatDuration(startedAt, finishedAt);

  const copy = (): void => {
    if (!error) return;
    void copyToClipboard(error).then((ok) =>
      toastStore.push(
        ok
          ? { kind: 'success', message: 'Logs copied' }
          : { kind: 'error', message: 'Could not copy — select and copy manually' },
      ),
    );
  };

  if (state === 'running' && !error) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted"
        data-testid="logs-running"
      >
        Compiling…
      </div>
    );
  }

  if (state === 'idle' || (!error && warnings.length === 0 && state !== 'error')) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted"
        data-testid="logs-empty"
      >
        No compile logs yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-page" data-testid="compile-logs">
      <div className="flex items-center justify-between border-b border-hairline-strong bg-surface px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <span
            className={
              state === 'error'
                ? 'font-semibold text-accent-text'
                : state === 'success'
                  ? 'font-semibold text-success-fg'
                  : 'text-muted'
            }
          >
            {state === 'error'
              ? 'Compile failed'
              : state === 'success'
                ? 'Compiled successfully'
                : 'Compile output'}
          </span>
          {errorCount > 0 ? (
            <span className="rounded-badge bg-accent-bg px-1.5 py-0.5 font-mono text-[11px] text-accent-text">
              {errorCount} error{errorCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {warningCount > 0 ? (
            <span className="rounded-badge bg-warning-bg px-1.5 py-0.5 font-mono text-[11px] text-warning-fg-strong">
              {warningCount} warning{warningCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {duration ? <span className="font-mono text-[11px] text-muted">{duration}</span> : null}
        </div>
        <div className="flex items-center gap-1">
          {state === 'error' && error && onAskClaude ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onAskClaude(error)}
              data-testid="compile-ask-claude"
            >
              Ask Claude to fix
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={copy} disabled={!error}>
            Copy
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {warnings.length > 0 ? (
          <div
            data-testid="compile-warnings"
            className="mb-3 rounded-box border-2 border-warning-border bg-surface p-3"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="rounded-badge bg-warning-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-warning-fg-strong">
                warning
              </span>
              <span className="font-sans text-sm font-semibold text-warning-fg-strong">
                The PDF compiled, but the preview is not what a recipient will see
              </span>
            </div>
            <ul className="list-disc space-y-1 pl-5 font-sans text-[12px] text-body-2">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {top ? (
          <button
            type="button"
            onClick={() => {
              if (onJumpToLine && top.line != null) onJumpToLine(top.line);
            }}
            disabled={!onJumpToLine || top.line == null}
            data-testid="compile-error-card"
            data-line={top.line ?? ''}
            className={`mb-3 block w-full rounded-box border-2 border-accent bg-surface p-3 text-left transition-colors ${
              onJumpToLine && top.line != null
                ? 'hover:bg-accent-bg-alt cursor-pointer'
                : 'cursor-default'
            }`}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="rounded-badge bg-accent-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent-text">
                {top.severity}
              </span>
              {top.line != null ? (
                <span className="font-mono text-[11px] text-muted">line {top.line}</span>
              ) : null}
              {onJumpToLine && top.line != null ? (
                <span className="ml-auto font-mono text-[10px] text-muted">click to jump</span>
              ) : null}
            </div>
            <div className="font-sans text-sm font-semibold text-accent-fg-strong">
              {top.message}
            </div>
            {top.context ? (
              <pre className="mt-1 whitespace-pre-wrap rounded bg-page px-2 py-1 font-mono text-[11px] text-body-2">
                {top.context}
              </pre>
            ) : null}
          </button>
        ) : null}
        {parsed.length > 1 ? (
          <ul
            data-testid="compile-entry-list"
            className="mb-3 divide-y divide-hairline rounded-box border border-hairline-strong bg-surface"
          >
            {parsed.map((entry, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => {
                    if (onJumpToLine && entry.line != null) onJumpToLine(entry.line);
                  }}
                  disabled={!onJumpToLine || entry.line == null}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors ${
                    onJumpToLine && entry.line != null
                      ? 'hover:bg-page cursor-pointer'
                      : 'cursor-default'
                  }`}
                >
                  <span
                    className={`rounded-badge px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                      entry.severity === 'error'
                        ? 'bg-accent-bg text-accent-text'
                        : 'bg-warning-bg text-warning-fg-strong'
                    }`}
                  >
                    {entry.severity}
                  </span>
                  {entry.line != null ? (
                    <span className="font-mono text-[10px] text-muted">line {entry.line}</span>
                  ) : null}
                  <span className="truncate font-mono text-body-2">{entry.message}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            data-testid="compile-show-raw"
            className="text-[11px] text-muted underline-offset-2 hover:text-body-2 hover:underline"
          >
            {showRaw ? 'Hide raw log' : 'Show raw log'}
          </button>
        </div>
        {showRaw || (parsed.length === 0 && !top) ? (
          blocks.length === 0 ? (
            <pre className="whitespace-pre-wrap text-body-2">{error}</pre>
          ) : (
            blocks.map((block, i) => {
              const cls =
                block.kind === 'error'
                  ? 'border-l-2 border-accent bg-accent-bg-alt text-accent-fg-strong'
                  : block.kind === 'warning'
                    ? 'border-l-2 border-warning-border bg-warning-bg-alt text-warning-fg-strong'
                    : 'text-body-2';
              return (
                <pre key={i} className={`mb-2 whitespace-pre-wrap rounded px-2 py-1 ${cls}`}>
                  {block.text}
                </pre>
              );
            })
          )
        ) : null}
      </div>
    </div>
  );
}
