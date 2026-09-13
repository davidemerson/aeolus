import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, ConfirmInline, Input, toastStore } from '@aeolus/shared/ui';

import { TopBar } from '../components/TopBar.js';
import { api, ApiRequestError } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useSession } from '../lib/session.js';
import { useRouter } from '../router.js';

interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  disabled_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export function AdminUsersRoute(): JSX.Element {
  const session = useSession();
  const { navigate } = useRouter();
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  // Inline rename state. The Name column doubles as a click-to-edit
  // surface. Empty/whitespace is rejected client-side; the API
  // already enforces min(1) max(200).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // A generated credential, held on screen until dismissed. Deliberately not a
  // toast: a toast expires, and this string exists exactly once.
  const [issued, setIssued] = useState<{ email: string; passphrase: string } | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    } else if (session.status === 'authenticated' && !session.user.isAdmin) {
      navigate('/docs', { replace: true });
    }
  }, [session, navigate]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ users: AdminUserRow[] }>('/admin/users');
      setRows(res.users);
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to load users',
      });
    }
  }, []);

  useEffect(() => {
    if (session.status === 'authenticated' && session.user.isAdmin) {
      void load();
    }
  }, [session, load]);

  const filtered = useMemo(() => {
    if (rows === null) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.email.toLowerCase().includes(q) || (r.name?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, filter]);

  const promote = useCallback(
    async (row: AdminUserRow): Promise<void> => {
      setWorking(row.id);
      try {
        await api.patch(`/admin/users/${encodeURIComponent(row.id)}`, {
          isAdmin: !row.is_admin,
        });
        await load();
        toastStore.push({
          kind: 'success',
          message: row.is_admin ? 'Demoted to user' : 'Promoted to admin',
        });
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Update failed',
        });
      } finally {
        setWorking(null);
      }
    },
    [load],
  );

  const startRename = useCallback((row: AdminUserRow) => {
    setRenamingId(row.id);
    setRenameDraft(row.name ?? '');
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft('');
  }, []);

  const saveRename = useCallback(
    async (row: AdminUserRow): Promise<void> => {
      const next = renameDraft.trim();
      if (next.length === 0) {
        toastStore.push({
          kind: 'error',
          message: 'Display name cannot be empty.',
        });
        return;
      }
      if (next === (row.name ?? '')) {
        cancelRename();
        return;
      }
      setWorking(row.id);
      try {
        await api.patch(`/admin/users/${encodeURIComponent(row.id)}`, {
          name: next,
        });
        toastStore.push({ kind: 'success', message: 'Display name updated' });
        cancelRename();
        await load();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Update failed',
        });
      } finally {
        setWorking(null);
      }
    },
    [renameDraft, cancelRename, load],
  );

  const createAccount = useCallback(async (): Promise<void> => {
    const email = newEmail.trim();
    if (email.length === 0 || creating) return;
    setCreating(true);
    try {
      const res = await api.post<{ user: AdminUserRow; passphrase: string }>('/admin/users', {
        email,
        ...(newName.trim() ? { name: newName.trim() } : {}),
        isAdmin: newIsAdmin,
      });
      setIssued({ email: res.user.email, passphrase: res.passphrase });
      setNewEmail('');
      setNewName('');
      setNewIsAdmin(false);
      await load();
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'The account could not be created.',
      });
    } finally {
      setCreating(false);
    }
  }, [newEmail, newName, newIsAdmin, creating, load]);

  const resetPassphrase = useCallback(async (row: AdminUserRow): Promise<void> => {
    setWorking(row.id);
    try {
      const res = await api.post<{ passphrase: string }>(
        `/admin/users/${encodeURIComponent(row.id)}/reset-passphrase`,
      );
      setIssued({ email: row.email, passphrase: res.passphrase });
      setConfirmReset(null);
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message:
          err instanceof ApiRequestError ? err.message : 'The passphrase could not be reset.',
      });
    } finally {
      setWorking(null);
    }
  }, []);

  // Enable/disable and delete used to be raw fetches in try/finally with
  // no catch: a network failure surfaced as an unhandled rejection and
  // nothing on screen. They now go through `api` (cookie + the global
  // 401 redirect) and every failure lands in a toast — the server's own
  // sentence when it sent one (e.g. refusing to disable your own
  // account), a generic one otherwise.
  const flip = useCallback(
    async (row: AdminUserRow): Promise<void> => {
      const action = row.disabled_at ? 'enable' : 'disable';
      setWorking(row.id);
      try {
        await api.post(`/admin/users/${encodeURIComponent(row.id)}/${action}`);
        await load();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message:
            err instanceof ApiRequestError
              ? err.message
              : action === 'disable'
                ? 'The account could not be disabled.'
                : 'The account could not be enabled.',
        });
      } finally {
        setWorking(null);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (row: AdminUserRow): Promise<void> => {
      setWorking(row.id);
      try {
        await api.delete(`/admin/users/${encodeURIComponent(row.id)}`);
        toastStore.push({ kind: 'success', message: 'User deleted' });
        setConfirmDelete(null);
        await load();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message:
            err instanceof ApiRequestError ? err.message : 'The account could not be deleted.',
        });
      } finally {
        setWorking(null);
      }
    },
    [load],
  );

  if (session.status !== 'authenticated' || !session.user.isAdmin) {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar user={session.user} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-body">Users</h1>
          <input
            type="text"
            placeholder="Filter by email or name…"
            aria-label="Filter users"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="admin-users-filter"
            className="w-64 rounded border border-hairline-strong bg-surface px-3 py-1.5 text-sm text-body placeholder-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          />
        </div>

        {issued ? (
          <div
            className="mb-6 rounded-card border border-hairline-strong bg-surface p-4 shadow-card"
            data-testid="admin-users-issued"
          >
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
              // one-time passphrase
            </div>
            <p className="mt-1 text-sm text-body-2">
              Give this to <span className="font-mono text-body">{issued.email}</span> yourself. It
              is shown once, it cannot be recovered, and they must replace it at first sign-in.
            </p>
            <p
              className="mt-3 select-all break-words rounded border border-hairline-strong bg-page px-3 py-2 font-mono text-sm text-body"
              data-testid="admin-users-issued-passphrase"
            >
              {issued.passphrase}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={() => setIssued(null)}
              data-testid="admin-users-issued-dismiss"
            >
              Done
            </Button>
          </div>
        ) : null}

        <div className="mb-6 rounded-card border border-hairline-strong bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold text-body">Add a user</h2>
          <p className="mt-1 text-xs text-muted">
            There is no self-service signup. Create the account here and hand over the passphrase it
            generates; the new user chooses their own the first time they sign in.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <Input
                label="Email"
                id="admin-users-new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                data-testid="admin-users-new-email"
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <Input
                label="Display name"
                id="admin-users-new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={200}
                data-testid="admin-users-new-name"
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-xs text-body-2">
              <input
                type="checkbox"
                checked={newIsAdmin}
                onChange={(e) => setNewIsAdmin(e.target.checked)}
                data-testid="admin-users-new-admin"
              />
              Administrator
            </label>
            <Button
              variant="primary"
              className="mb-[1px]"
              disabled={creating || newEmail.trim().length === 0}
              onClick={() => void createAccount()}
              data-testid="admin-users-create"
            >
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>

        {rows === null ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted" data-testid="admin-users-empty">
            {filter.trim() ? 'No users match.' : 'No users yet.'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-card border border-hairline-strong bg-surface shadow-card">
            <table className="w-full text-sm" data-testid="admin-users-table">
              <thead className="bg-page text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Last seen</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {filtered.map((r) => (
                  <tr key={r.id} data-testid={`admin-user-row-${r.id}`}>
                    <td
                      className="max-w-[280px] truncate px-4 py-2 font-mono text-xs"
                      title={r.email}
                    >
                      {r.email}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      {renamingId === r.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveRename(r);
                              else if (e.key === 'Escape') cancelRename();
                            }}
                            maxLength={200}
                            className="!py-1 !text-sm"
                            data-testid={`admin-user-rename-input-${r.id}`}
                          />
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={working === r.id}
                            onClick={() => void saveRename(r)}
                            data-testid={`admin-user-rename-save-${r.id}`}
                          >
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working === r.id}
                            onClick={cancelRename}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="-mx-1 block max-w-[220px] truncate rounded-badge px-1 py-0.5 text-left hover:bg-fill-hover"
                          onClick={() => startRename(r)}
                          data-testid={`admin-user-rename-${r.id}`}
                          title="Click to rename"
                        >
                          {r.name ?? <span className="italic text-muted">—</span>}
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span
                        className={`rounded-badge px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                          r.is_admin ? 'bg-accent-bg text-accent-text' : 'bg-fill-warm text-body-2'
                        }`}
                      >
                        {r.is_admin ? 'Admin' : 'User'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-body-2">
                      {formatDateTime(r.last_seen_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      {r.disabled_at ? (
                        <span className="rounded-badge bg-warning-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning-fg-strong">
                          disabled
                        </span>
                      ) : (
                        <span className="rounded-badge bg-success-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success-fg">
                          active
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      {confirmReset === r.id ? (
                        <ConfirmInline
                          className="justify-end"
                          message={`Issue a new passphrase for ${r.email}?`}
                          confirmLabel={working === r.id ? 'Resetting…' : 'Reset'}
                          pending={working === r.id}
                          onConfirm={() => void resetPassphrase(r)}
                          onCancel={() => setConfirmReset(null)}
                          testId={`admin-user-reset-${r.id}`}
                        />
                      ) : confirmDelete === r.id ? (
                        <ConfirmInline
                          className="justify-end"
                          message={`Delete ${r.email}?`}
                          confirmLabel={working === r.id ? 'Deleting…' : 'Delete'}
                          destructive
                          pending={working === r.id}
                          onConfirm={() => void remove(r)}
                          onCancel={() => setConfirmDelete(null)}
                          testId={`admin-user-delete-${r.id}`}
                        />
                      ) : (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working === r.id}
                            onClick={() => void promote(r)}
                          >
                            {r.is_admin ? 'Demote' : 'Promote'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working === r.id}
                            onClick={() => void flip(r)}
                          >
                            {r.disabled_at ? 'Enable' : 'Disable'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working === r.id}
                            onClick={() => setConfirmReset(r.id)}
                            data-testid={`admin-user-reset-${r.id}`}
                          >
                            Reset passphrase
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working === r.id}
                            onClick={() => setConfirmDelete(r.id)}
                            data-testid={`admin-user-delete-${r.id}`}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
