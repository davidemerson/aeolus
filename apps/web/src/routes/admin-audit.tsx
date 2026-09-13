import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Select, toastStore } from '@aeolus/shared/ui';

import { TopBar } from '../components/TopBar.js';
import { api, ApiRequestError } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useSession } from '../lib/session.js';
import { useRouter } from '../router.js';

interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
}

interface AuditResponse {
  events: AuditEvent[];
  next_before: string | null;
  retention_days: number;
}

const ACTION_PREFIXES = [
  { value: '', label: 'All actions' },
  { value: 'auth.', label: 'Authentication (logins, logouts)' },
  { value: 'doc.', label: 'Documents (create, update, delete, open)' },
  { value: 'template.', label: 'Templates' },
  { value: 'user.', label: 'User management' },
];

export function AdminAuditRoute(): JSX.Element {
  const session = useSession();
  const { navigate } = useRouter();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  // Starts true: the first request is in flight from the first render, and
  // an empty list before it answers is "loading", not "no events".
  const [loading, setLoading] = useState(true);
  // Guards against overlapping requests without putting `loading` in a
  // dependency array (which would re-create `reload` on every toggle).
  const inFlight = useRef(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState('');
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    } else if (session.status === 'authenticated' && !session.user.isAdmin) {
      navigate('/docs', { replace: true });
    }
  }, [session, navigate]);

  const reload = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (actionFilter) params.set('action', actionFilter);
      params.set('limit', '50');
      const res = await api.get<AuditResponse>(
        `/admin/audit-events${params.size > 0 ? `?${params.toString()}` : ''}`,
      );
      setEvents(res.events);
      setNextBefore(res.next_before);
      setRetentionDays(res.retention_days);
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to load audit log',
      });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [actionFilter]);

  const isAdmin = session.status === 'authenticated' && session.user.isAdmin;
  useEffect(() => {
    if (isAdmin) void reload();
  }, [isAdmin, reload]);

  const loadMore = async (): Promise<void> => {
    if (inFlight.current || !nextBefore) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (actionFilter) params.set('action', actionFilter);
      params.set('before', nextBefore);
      params.set('limit', '50');
      const res = await api.get<AuditResponse>(`/admin/audit-events?${params.toString()}`);
      setEvents((prev) => [...prev, ...res.events]);
      setNextBefore(res.next_before);
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to load more',
      });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const activeFilter = ACTION_PREFIXES.find((p) => p.value === actionFilter);

  if (session.status !== 'authenticated' || !session.user.isAdmin) {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <>
      <TopBar user={session.user} />
      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-body">Audit log</h1>
            <p className="mt-1 text-sm text-muted">
              {retentionDays != null
                ? `Showing the last ${retentionDays} days of authentication and major mutation events.`
                : 'Authentication and major mutation events.'}
            </p>
          </div>
          <Button
            variant="ghost"
            onClick={() => void reload()}
            disabled={loading}
            data-testid="audit-refresh"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>

        <div className="mb-4 w-full max-w-sm">
          <Select
            id="audit-filter"
            label="Filter"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            data-testid="audit-filter"
          >
            {ACTION_PREFIXES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>

        {events.length === 0 && loading ? (
          <div
            className="rounded-card border border-hairline-strong bg-surface p-6 text-sm text-muted"
            data-testid="audit-loading"
          >
            Loading…
          </div>
        ) : events.length === 0 ? (
          <div
            className="rounded-card border border-hairline-strong bg-surface p-6 text-sm text-muted"
            data-testid="audit-empty"
          >
            {actionFilter && activeFilter
              ? `No events under “${activeFilter.label}” in this period. Pick “All actions” to widen the search.`
              : 'No events to show.'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-card border border-hairline-strong bg-surface">
            <table className="min-w-full divide-y divide-hairline-strong text-sm">
              <thead className="bg-page text-left text-xs uppercase tracking-wide text-body-2">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Actor</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Resource</th>
                  <th className="px-3 py-2">Details</th>
                  <th className="px-3 py-2">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline" data-testid="audit-rows">
                {events.map((e) => (
                  <tr key={e.id} data-testid={`audit-row-${e.id}`}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-body-2">
                      {formatDateTime(e.occurred_at)}
                    </td>
                    <td
                      className="max-w-[220px] truncate px-3 py-2 text-body-2"
                      title={e.actor_email ?? undefined}
                    >
                      {e.actor_email ?? <span className="text-muted">not signed in</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <code className="rounded-badge bg-fill-warm px-1.5 py-0.5 text-xs text-body-2">
                        {e.action}
                      </code>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-body-2">
                      {e.resource_type ? (
                        <>
                          <span className="text-muted">{e.resource_type}</span>
                          {e.resource_id ? (
                            <span className="ml-1 font-mono text-body-2">
                              {e.resource_id.slice(0, 8)}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td
                      className="max-w-md whitespace-nowrap px-3 py-2 text-xs text-body-2"
                      title={
                        Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : undefined
                      }
                    >
                      {Object.keys(e.metadata).length > 0 ? (
                        <code className="block truncate font-mono">
                          {JSON.stringify(e.metadata)}
                        </code>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">
                      {e.ip ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextBefore ? (
          <div className="mt-4">
            <Button
              variant="ghost"
              onClick={() => void loadMore()}
              disabled={loading}
              data-testid="audit-load-more"
            >
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </main>
    </>
  );
}
