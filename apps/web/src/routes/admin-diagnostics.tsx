import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Input, toastStore } from '@aeolus/shared/ui';

import { TopBar } from '../components/TopBar.js';
import { api, ApiRequestError } from '../lib/api.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { formatDateTime } from '../lib/format.js';
import { useSession } from '../lib/session.js';
import { useRouter } from '../router.js';

interface DiagSnapshot {
  ts: string;
  queue:
    | {
        queue: string;
        total_jobs: number;
        jobs_in_last_hour: number;
        oldest_unfinished_seconds: number | null;
      }
    | { error: string };
  compiles: {
    recent_total: number;
    by_status: Record<string, number>;
    oldest_queued_seconds: number | null;
    most_recent: Array<{
      job_id: string;
      status: string;
      error_first_line: string | null;
      age_seconds: number;
    }>;
  };
  compile_boss_attached: boolean;
  ws?:
    | {
        status: number;
        body:
          | string
          | {
              ts?: string;
              rooms?: number;
              recent_persist_errors?: Array<{
                docId: string;
                seq: string;
                bytes: number;
                authorId: string | null;
                message: string;
                at: number;
              }>;
              error?: string;
            };
      }
    | { error: string };
}

interface SmokeResult {
  ok: boolean;
  doc_id: string;
  job_id: string;
  status: string;
  elapsed_ms: number | null;
  pdf_key: string | null;
  error: string | null;
  persistence?: {
    local_text_length: number;
    local_update_bytes: number;
    persisted_rows: number;
    persisted_update_bytes: number;
    api_loaded_source_length: number;
  };
}

export function AdminDiagnosticsRoute() {
  const session = useSession();
  const { navigate } = useRouter();
  const [snapshot, setSnapshot] = useState<DiagSnapshot | null>(null);
  // Why the last snapshot fetch failed. While there is no snapshot yet it
  // renders in place of the card with a Retry; once one is on screen a
  // failed refresh toasts and the stale snapshot stays visible.
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SmokeResult | null>(null);
  const [botCookie, setBotCookie] = useState<string | null>(null);
  const [botMinting, setBotMinting] = useState(false);
  const [botEmail, setBotEmail] = useState('');
  const trimmedBotEmail = botEmail.trim();
  // Deliberately shallow: the server validates properly, and a stricter
  // client-side pattern would only reject addresses the server accepts.
  const botEmailUsable = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedBotEmail);

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    } else if (session.status === 'authenticated' && !session.user.isAdmin) {
      navigate('/docs', { replace: true });
    }
  }, [session, navigate]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await api.get<DiagSnapshot>('/admin/diagnostics');
      setSnapshot(res);
      setSnapshotError(null);
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : 'The diagnostics could not be loaded.';
      setSnapshotError(message);
      toastStore.push({ kind: 'error', message });
    }
  }, []);

  const isAdmin = session.status === 'authenticated' && session.user.isAdmin;
  useEffect(() => {
    if (isAdmin) void refresh();
  }, [isAdmin, refresh]);

  const runSmoke = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    try {
      const res = await api.post<SmokeResult>('/admin/diagnostics/compile');
      setResult(res);
      toastStore.push({
        kind: res.ok ? 'success' : 'error',
        message: res.ok
          ? `Smoke compile OK in ${res.elapsed_ms ?? '?'} ms`
          : `Smoke compile failed: ${res.status}`,
      });
      await refresh();
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to run smoke compile',
      });
    } finally {
      setRunning(false);
    }
  };

  if (session.status !== 'authenticated' || !session.user.isAdmin) {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <>
      <TopBar user={session.user} />
      <main className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="mb-6 text-xl font-semibold tracking-tight text-body">Diagnostics</h1>

        <Card title="Bot session for operator tooling">
          <p className="mb-3 text-sm text-body-2">
            Mints a long-lived non-rotating session for the account you name below (created if
            absent). Paste the resulting cookie into your tool's{' '}
            <code className="font-mono">~/.config/aeolus/bot-session</code> file (or equivalent).
            The token is good for the full 30-day absolute TTL and can be revoked by deleting the
            row from the <code className="font-mono">sessions</code> table.
          </p>
          {/* The account used to be hardcoded to one person's personal address,
              which put a real mailbox in this page's copy and in every
              screenshot of it, and silently tied the fleet's operator tooling
              to one individual. The operator names the identity instead: it is
              their tooling, and nothing here has to know who they are. */}
          <Input
            name="bot-email"
            type="email"
            label="Bot account email"
            placeholder="aeolus-bot@your-domain.example"
            value={botEmail}
            onChange={(e) => setBotEmail(e.target.value)}
            className="mb-3"
            data-testid="mint-bot-email"
          />
          <Button
            onClick={() => {
              setBotMinting(true);
              setBotCookie(null);
              api
                .post<{ cookie_header?: string }>('/admin/bot-session', {
                  email: trimmedBotEmail,
                  // The local part is a good enough display name for a
                  // non-interactive account, and saves asking for a second
                  // field nobody wants to fill in.
                  name: trimmedBotEmail.split('@')[0],
                  is_admin: true,
                })
                .then((j) => {
                  if (j.cookie_header) {
                    setBotCookie(j.cookie_header);
                  } else {
                    toastStore.push({
                      kind: 'error',
                      message: 'The bot session could not be created.',
                    });
                  }
                })
                .catch((e: unknown) =>
                  toastStore.push({
                    kind: 'error',
                    message:
                      e instanceof ApiRequestError
                        ? e.message
                        : 'The bot session could not be created.',
                  }),
                )
                .finally(() => setBotMinting(false));
            }}
            disabled={botMinting || !botEmailUsable}
            data-testid="mint-bot-btn"
          >
            {botMinting ? 'Minting…' : 'Mint bot session'}
          </Button>
          {botCookie ? (
            <div className="mt-4">
              <textarea
                readOnly
                value={botCookie}
                rows={3}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                className="w-full rounded border border-hairline-strong bg-page p-2 font-mono text-xs"
                data-testid="bot-cookie-output"
              />
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => {
                  void copyToClipboard(botCookie).then((ok) =>
                    toastStore.push(
                      ok
                        ? { kind: 'success', message: 'Copied to clipboard' }
                        : { kind: 'error', message: 'Could not copy — select and copy manually' },
                    ),
                  );
                }}
              >
                Copy
              </Button>
            </div>
          ) : null}
        </Card>

        <div className="mt-6" />
        <Card title="Smoke compile">
          <p className="mb-3 text-sm text-body-2">
            Runs a known-good LaTeX document through the same pipeline a user compile hits — enqueue
            → worker → tectonic → S3 → result. The seeded doc is soft-deleted on the way out. Use
            this to answer “is the worker actually compiling anything” end-to-end.
          </p>
          <Button onClick={() => void runSmoke()} disabled={running} data-testid="diag-run">
            {running ? 'Running…' : 'Run smoke compile'}
          </Button>
          {result ? (
            <div
              className={`mt-4 rounded-box border p-4 text-sm ${
                result.ok
                  ? 'border-success-border bg-success-bg-alt text-success-fg-strong'
                  : 'border-accent-border bg-accent-bg-alt text-accent-fg-strong'
              }`}
              data-testid="diag-result"
            >
              <div className="font-mono text-xs">
                status: {result.status}
                {result.elapsed_ms !== null ? ` · elapsed: ${result.elapsed_ms} ms` : ''}
                {' · '}
                doc: {result.doc_id} · job: {result.job_id}
              </div>
              {result.pdf_key ? (
                <div className="mt-1 font-mono text-xs">pdf_key: {result.pdf_key}</div>
              ) : null}
              {result.error ? (
                <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{result.error}</pre>
              ) : null}
              {/* The divider takes the family's own border role, not
                  `border-current/20`: that modifier is dropped on a
                  var()-backed colour, so the rule painted Tailwind
                  preflight's #e5e7eb — a cool grey line inside a warm
                  success/accent block. */}
              {result.persistence ? (
                <div
                  className={`mt-3 border-t pt-2 font-mono text-xs ${
                    result.ok ? 'border-success-border' : 'border-accent-border'
                  }`}
                >
                  <div className="font-semibold not-italic">
                    Persistence self-check (api side, before worker):
                  </div>
                  <div>local_text_length: {result.persistence.local_text_length}</div>
                  <div>local_update_bytes: {result.persistence.local_update_bytes}</div>
                  <div>persisted_rows: {result.persistence.persisted_rows}</div>
                  <div>persisted_update_bytes: {result.persistence.persisted_update_bytes}</div>
                  <div>api_loaded_source_length: {result.persistence.api_loaded_source_length}</div>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>

        <h2 className="mt-8 mb-3 text-lg font-semibold text-body">Snapshot</h2>
        {snapshot === null && snapshotError !== null ? (
          <Card data-testid="diag-snapshot-error">
            <p className="text-sm text-danger-fg">{snapshotError}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={() => void refresh()}
              data-testid="diag-retry"
            >
              Retry
            </Button>
          </Card>
        ) : snapshot === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <Card>
            <div className="grid grid-cols-1 gap-3 text-sm">
              <div>
                <span className="font-semibold">Queue:</span>{' '}
                {'error' in snapshot.queue ? (
                  <span className="text-accent-text" data-testid="diag-queue-error">
                    {snapshot.queue.error}
                  </span>
                ) : (
                  <span className="font-mono">
                    {snapshot.queue.queue} · {snapshot.queue.total_jobs} total ·{' '}
                    {snapshot.queue.jobs_in_last_hour} in last hour ·{' '}
                    {snapshot.queue.oldest_unfinished_seconds === null
                      ? 'no unfinished'
                      : `oldest unfinished ${snapshot.queue.oldest_unfinished_seconds}s`}
                  </span>
                )}
              </div>
              <div>
                <span className="font-semibold">compileBoss attached:</span>{' '}
                <code className="font-mono">{String(snapshot.compile_boss_attached)}</code>
              </div>
              <div>
                <span className="font-semibold">Recent compiles (1h):</span>{' '}
                <code className="font-mono">
                  total {snapshot.compiles.recent_total} ·{' '}
                  {Object.entries(snapshot.compiles.by_status)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ') || 'none'}
                </code>
              </div>
              {snapshot.compiles.most_recent.length > 0 ? (
                <div>
                  <span className="font-semibold">Most recent jobs:</span>
                  <ul className="mt-1 space-y-1 font-mono text-xs">
                    {snapshot.compiles.most_recent.map((j) => (
                      <li key={j.job_id}>
                        [{j.status}] {j.age_seconds}s ago — {j.job_id}
                        {j.error_first_line ? ` · ${j.error_first_line}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {snapshot.ws ? (
                <div>
                  <span className="font-semibold">WS persist errors (last 50):</span>
                  {'error' in snapshot.ws ? (
                    <div className="mt-1 text-accent-text">
                      <code className="font-mono">{snapshot.ws.error}</code>
                    </div>
                  ) : typeof snapshot.ws.body === 'string' ? (
                    <div className="mt-1 text-accent-text">
                      [{snapshot.ws.status}] {snapshot.ws.body}
                    </div>
                  ) : 'recent_persist_errors' in snapshot.ws.body &&
                    snapshot.ws.body.recent_persist_errors ? (
                    snapshot.ws.body.recent_persist_errors.length === 0 ? (
                      <div className="mt-1 text-success-fg">
                        none — ws is persisting cleanly. Rooms: {snapshot.ws.body.rooms ?? '?'}
                      </div>
                    ) : (
                      <ul className="mt-1 space-y-2 font-mono text-xs">
                        {snapshot.ws.body.recent_persist_errors
                          .slice(-10)
                          .reverse()
                          .map((e, i) => (
                            <li
                              key={i}
                              className="rounded border border-accent-border bg-accent-bg-alt p-2 text-accent-fg-strong"
                            >
                              <div>
                                {formatDateTime(e.at)} · doc {e.docId.slice(0, 8)} · seq {e.seq} ·{' '}
                                {e.bytes}B
                              </div>
                              <div className="whitespace-pre-wrap">{e.message}</div>
                            </li>
                          ))}
                      </ul>
                    )
                  ) : (
                    <div className="mt-1 text-muted">
                      [{snapshot.ws.status}] {JSON.stringify(snapshot.ws.body)}
                    </div>
                  )}
                </div>
              ) : null}
              <div className="text-xs text-muted">snapshot at {formatDateTime(snapshot.ts)}</div>
              <div>
                <Button variant="ghost" onClick={() => void refresh()} data-testid="diag-refresh">
                  Refresh
                </Button>
              </div>
            </div>
          </Card>
        )}
      </main>
    </>
  );
}
