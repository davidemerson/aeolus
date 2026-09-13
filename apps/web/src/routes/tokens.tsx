import { useCallback, useEffect, useState } from 'react';

import { Button, ConfirmInline, Input, Select, toastStore } from '@aeolus/shared/ui';

import { TopBar } from '../components/TopBar.js';
import { api, ApiRequestError, type ApiToken, type TokenListResponse } from '../lib/api.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { formatDateTime } from '../lib/format.js';
import { useSession } from '../lib/session.js';
import { useRouter } from '../router.js';

export function TokensRoute(): JSX.Element {
  const session = useSession();
  const { navigate } = useRouter();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [minting, setMinting] = useState(false);
  // The plaintext lives ONLY here, in component state. It is never written to
  // localStorage and never re-fetched: navigating away loses it for good,
  // which is the intended behaviour and is said so in the panel.
  const [justMinted, setJustMinted] = useState<{ token: string; name: string } | null>(null);
  // Token whose revoke is awaiting the inline confirm, and the one whose
  // DELETE is in flight. window.confirm() is blocked when the app is framed
  // in the portal, which made revoking impossible there.
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === 'anonymous') navigate('/login', { replace: true });
  }, [session.status, navigate]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<TokenListResponse>('/tokens');
      setTokens(res.tokens);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return;
      toastStore.push({ kind: 'error', message: 'Could not load tokens' });
    }
  }, []);

  useEffect(() => {
    if (session.status === 'authenticated') void load();
  }, [session.status, load]);

  const mint = useCallback(async () => {
    const trimmed = name.trim();
    if (minting || trimmed.length === 0) return;
    setMinting(true);
    try {
      const res = await api.post<{ token: string; created: ApiToken }>('/tokens', {
        name: trimmed,
        scope,
      });
      setJustMinted({ token: res.token, name: res.created.name });
      setName('');
      setScope('read');
      await load();
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Could not create the token',
      });
    } finally {
      setMinting(false);
    }
  }, [name, scope, minting, load]);

  const revoke = useCallback(
    async (t: ApiToken) => {
      setRevokingId(t.id);
      try {
        await api.delete(`/tokens/${t.id}`);
        toastStore.push({ kind: 'success', message: `Revoked ${t.name}` });
        setConfirmRevokeId(null);
        await load();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Could not revoke',
        });
      } finally {
        setRevokingId(null);
      }
    },
    [load],
  );

  const copy = useCallback(async (value: string) => {
    if (await copyToClipboard(value)) {
      toastStore.push({ kind: 'success', message: 'Copied to clipboard' });
    } else {
      toastStore.push({ kind: 'error', message: 'Could not copy — select and copy manually' });
    }
  }, []);

  if (session.status !== 'authenticated') {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar user={session.user} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-body">API tokens</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Tokens authenticate automation against the{' '}
          <code className="font-mono text-[12px]">/api/v1</code> API. A token acts as the person who
          created it and carries their document permissions, so it can only reach documents they can
          reach.
        </p>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Everyone signed in can see and revoke every token. That is deliberate: a token writes to
          shared documents, so a revoke should never wait for one person to be available.
        </p>

        {justMinted ? (
          <section
            className="mt-8 rounded border border-hairline-strong bg-surface p-5"
            data-testid="tokens-plaintext"
          >
            <h2 className="text-sm font-semibold text-body">
              Copy “{justMinted.name}” now — this is the only time it is shown
            </h2>
            <p className="mt-1 text-sm text-muted">
              Only a hash is stored. Nobody can show it to you again, including an administrator.
              Leave this page and it is gone.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-fill-hover px-3 py-2 font-mono text-[12px] text-body">
                {justMinted.token}
              </code>
              <Button onClick={() => void copy(justMinted.token)}>Copy</Button>
              <Button variant="ghost" onClick={() => setJustMinted(null)}>
                Done
              </Button>
            </div>
          </section>
        ) : null}

        <section className="mt-8 rounded border border-hairline-strong bg-surface p-5">
          <h2 className="text-sm font-semibold text-body">Create a token</h2>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[16rem] flex-1">
              <Input
                id="token-name"
                label="What is it for?"
                value={name}
                maxLength={120}
                placeholder="nightly-thesis-build"
                onChange={(e) => setName(e.currentTarget.value)}
                data-testid="token-name"
              />
            </div>
            <Select
              id="token-scope"
              label="Access"
              value={scope}
              onChange={(e) => setScope(e.currentTarget.value === 'write' ? 'write' : 'read')}
              data-testid="token-scope"
            >
              <option value="read">Read only</option>
              <option value="write">Read and write</option>
            </Select>
            <Button
              onClick={() => void mint()}
              disabled={minting || name.trim().length === 0}
              data-testid="token-create"
            >
              {minting ? 'Creating…' : 'Create token'}
            </Button>
          </div>
          <p className="mt-3 text-sm text-muted">
            Read-only permits <code className="font-mono text-[12px]">GET</code> and{' '}
            <code className="font-mono text-[12px]">HEAD</code>. The choice is fixed for the life of
            the token — to change it, create a new one and revoke this one.
          </p>
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold text-body">Existing tokens</h2>
          {tokens === null ? (
            <p className="mt-3 text-sm text-muted">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No tokens yet. Nothing is calling the API with one.
            </p>
          ) : (
            <table className="mt-3 w-full text-left text-sm" data-testid="tokens-table">
              <thead className="text-muted">
                <tr className="border-b border-hairline-strong">
                  <th className="py-2 font-normal">Name</th>
                  <th className="py-2 font-normal">Access</th>
                  <th className="py-2 font-normal">Created by</th>
                  <th className="py-2 font-normal">Created</th>
                  <th className="py-2 font-normal">Last used</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className="border-b border-hairline" data-testid="token-row">
                    {/* The id is an internal handle nobody types; it stays
                        reachable in the tooltip for support conversations. */}
                    <td className="py-2 text-body" title={`Token id ${t.id}`}>
                      {t.name}
                    </td>
                    <td className="py-2 text-muted">
                      {t.scope === 'write' ? 'Read and write' : 'Read only'}
                    </td>
                    <td className="py-2 text-muted">{t.created_by_email ?? '—'}</td>
                    <td className="py-2 text-muted">{formatDateTime(t.created_at)}</td>
                    <td className="py-2 text-muted">{formatDateTime(t.last_used_at)}</td>
                    <td className="py-2 text-right">
                      {confirmRevokeId === t.id ? (
                        <ConfirmInline
                          className="justify-end"
                          message={`Revoke “${t.name}”? Anything using it fails on its next request. This cannot be undone.`}
                          confirmLabel={revokingId === t.id ? 'Revoking…' : 'Revoke'}
                          destructive
                          pending={revokingId === t.id}
                          onConfirm={() => void revoke(t)}
                          onCancel={() => setConfirmRevokeId(null)}
                          testId={`token-revoke-${t.id}`}
                        />
                      ) : (
                        <Button
                          variant="ghost"
                          disabled={revokingId !== null}
                          onClick={() => setConfirmRevokeId(t.id)}
                          data-testid={`token-revoke-${t.id}`}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-sm text-muted">
            “Last used” is approximate — it is stamped at most once every five minutes, which is
            enough to tell a live token from an abandoned one.
          </p>
        </section>
      </main>
    </div>
  );
}
