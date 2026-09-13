import { useCallback, useEffect, useState } from 'react';

import { Button, Card, ConfirmInline, Input, Select, toastStore } from '@aeolus/shared/ui';

import { TopBar } from '../components/TopBar.js';
import { api, ApiRequestError, type Template, type TemplateListResponse } from '../lib/api.js';
import { engineLabel } from '../lib/format.js';
import { useSession } from '../lib/session.js';
import { Link, useRouter } from '../router.js';

export function AdminTemplatesRoute() {
  const session = useSession();
  const { navigate } = useRouter();
  const [list, setList] = useState<Template[] | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [engine, setEngine] = useState<'latex' | 'typst'>('latex');
  const [creating, setCreating] = useState(false);
  // Template whose publish/unpublish/delete request is in flight; its two
  // buttons disable so a second click cannot start a parallel request.
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    } else if (session.status === 'authenticated' && !session.user.isAdmin) {
      navigate('/docs', { replace: true });
    }
  }, [session, navigate]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.get<TemplateListResponse>('/templates');
      setList(res.templates);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Failed to load templates';
      toastStore.push({ kind: 'error', message });
      setList([]);
    }
  }, []);

  const isAdmin = session.status === 'authenticated' && session.user.isAdmin;
  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const create = async (): Promise<void> => {
    if (creating || name.trim().length === 0) return;
    setCreating(true);
    try {
      const res = await api.post<{ template: Template }>('/templates', {
        name: name.trim(),
        description: description.trim() || undefined,
        engine,
      });
      toastStore.push({ kind: 'success', message: `Template "${res.template.name}" created` });
      setName('');
      setDescription('');
      navigate(`/admin/templates/${res.template.id}`);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Failed to create template';
      toastStore.push({ kind: 'error', message });
    } finally {
      setCreating(false);
    }
  };

  const togglePublish = async (t: Template): Promise<void> => {
    const next = !t.is_published;
    setWorkingId(t.id);
    try {
      // snake_case: the same spelling the response uses, and the same as
      // every other field on this API's wire. The camelCase spelling is still
      // accepted for back-compat, but nothing new should be written in it.
      await api.patch<{ template: Template }>(`/templates/${t.id}`, {
        is_published: next,
      });
      await load();
      toastStore.push({
        kind: 'success',
        message: next
          ? `Published "${t.name}" — visible to all users on /docs`
          : `Unpublished "${t.name}" — now hidden from /docs`,
      });
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Failed to update template';
      toastStore.push({ kind: 'error', message });
    } finally {
      setWorkingId(null);
    }
  };

  const remove = async (t: Template): Promise<void> => {
    setWorkingId(t.id);
    try {
      await api.delete(`/templates/${t.id}`);
      setConfirmDeleteId(null);
      await load();
      toastStore.push({ kind: 'success', message: `Deleted “${t.name}”` });
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Failed to delete template';
      toastStore.push({ kind: 'error', message });
    } finally {
      setWorkingId(null);
    }
  };

  if (session.status !== 'authenticated' || !session.user.isAdmin) {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <>
      <TopBar user={session.user} />
      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-body">Branded templates</h1>
        </div>

        <Card title="Create a template">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input
              name="name"
              label="Name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="template-name-input"
            />
            <Input
              name="description"
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="template-description-input"
            />
            <Select
              name="engine"
              label="Engine"
              value={engine}
              onChange={(e) => setEngine(e.target.value === 'typst' ? 'typst' : 'latex')}
              data-testid="template-engine"
            >
              <option value="latex">LaTeX</option>
              <option value="typst">Typst</option>
            </Select>
            <Button type="submit" disabled={creating} data-testid="template-create">
              {creating ? 'Creating…' : 'Create template'}
            </Button>
          </form>
        </Card>

        <h2 className="mt-10 mb-3 text-lg font-semibold text-body">Existing templates</h2>
        {list === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : list.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No templates yet.</p>
          </Card>
        ) : (
          <ul className="grid grid-cols-1 gap-3" data-testid="templates-list">
            {list.map((t) => (
              <li
                key={t.id}
                className="rounded-card border border-hairline-strong bg-surface p-4 shadow-card"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/admin/templates/${t.id}`}
                        className="text-sm font-semibold text-body hover:underline"
                      >
                        {t.name}
                      </Link>
                      <span
                        className={
                          t.is_published
                            ? 'rounded-badge bg-success-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success-fg-strong'
                            : 'rounded-badge bg-hairline-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-body-2'
                        }
                        data-testid={`template-state-${t.id}`}
                      >
                        {t.is_published ? 'Published' : 'Draft'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted">{engineLabel(t.engine)}</div>
                    {t.description ? (
                      <p className="mt-2 text-sm text-body-2">{t.description}</p>
                    ) : null}
                  </div>
                  {confirmDeleteId === t.id ? (
                    <ConfirmInline
                      className="justify-end"
                      message={`Delete “${t.name}”? This cannot be undone.`}
                      confirmLabel={workingId === t.id ? 'Deleting…' : 'Delete'}
                      destructive
                      pending={workingId === t.id}
                      onConfirm={() => void remove(t)}
                      onCancel={() => setConfirmDeleteId(null)}
                      testId={`template-delete-${t.id}`}
                    />
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Button
                        variant="ghost"
                        disabled={workingId === t.id}
                        aria-busy={workingId === t.id || undefined}
                        onClick={() => void togglePublish(t)}
                        data-testid={`template-publish-${t.id}`}
                      >
                        {workingId === t.id
                          ? t.is_published
                            ? 'Unpublishing…'
                            : 'Publishing…'
                          : t.is_published
                            ? 'Unpublish'
                            : 'Publish'}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={workingId === t.id}
                        onClick={() => setConfirmDeleteId(t.id)}
                        data-testid={`template-delete-${t.id}`}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
