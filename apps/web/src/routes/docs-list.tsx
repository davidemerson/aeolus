import { useEffect, useState } from 'react';

import { Button, ConfirmInline, toastStore } from '@aeolus/shared/ui';

import { TopBar } from '../components/TopBar.js';
import {
  api,
  ApiRequestError,
  type DocListResponse,
  type DocSummary,
  type Template,
  type TemplateListResponse,
} from '../lib/api.js';
import { engineLabel } from '../lib/format.js';
import { useSession } from '../lib/session.js';
import { Link, useRouter } from '../router.js';

export function DocsListRoute() {
  const session = useSession();
  const { navigate } = useRouter();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [creating, setCreating] = useState(false);
  // Engine for the next blank document. LaTeX stays the default because
  // it is what the seeded templates and the bundled packages target;
  // Typst is one click away rather than unreachable.
  const [newEngine, setNewEngine] = useState<'latex' | 'typst'>('latex');
  const [forkingId, setForkingId] = useState<string | null>(null);
  // When the user clicks "New from template", we open a small inline
  // form that lets them name the new doc. Default is
  // `<template name> <unix epoch>` — gives a sequential, sortable
  // identifier without two forks ever colliding on title.
  const [forkPrompt, setForkPrompt] = useState<{
    template: Template;
    title: string;
  } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Document whose archive / unarchive request is in flight.
  const [archivingId, setArchivingId] = useState<string | null>(null);
  // Workspace tab. "active" hides archived docs; "archived" shows
  // only archived ones. Templates only appear on the active tab —
  // forking from the archived view doesn't make sense.
  const [view, setView] = useState<'active' | 'archived'>('active');

  // The /docs page is the user-facing entry point even for admins —
  // unpublished drafts should not show as fork cards here regardless
  // of who's looking, otherwise the publish/unpublish toggle has no
  // visible effect for admins. /admin/templates remains the place
  // where admins see drafts.
  const visibleTemplates = templates.filter((t) => t.is_published);

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    }
  }, [session, navigate]);

  useEffect(() => {
    if (session.status !== 'authenticated') return;
    let cancelled = false;
    setDocs(null);
    void (async () => {
      try {
        const [docRes, tmplRes] = await Promise.all([
          api.get<DocListResponse>(`/docs?status=${view}`),
          api.get<TemplateListResponse>('/templates'),
        ]);
        if (cancelled) return;
        setDocs(docRes.docs);
        setTemplates(tmplRes.templates);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ApiRequestError ? err.message : 'Failed to load documents';
        toastStore.push({ kind: 'error', message });
        setDocs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.status, view]);

  const openForkPrompt = (tmpl: Template): void => {
    if (forkingId) return;
    setForkPrompt({
      template: tmpl,
      title: `${tmpl.name} ${Math.floor(Date.now() / 1000)}`,
    });
  };

  const submitFork = async (): Promise<void> => {
    if (!forkPrompt || forkingId) return;
    const title = forkPrompt.title.trim();
    if (title.length === 0) {
      toastStore.push({ kind: 'error', message: 'Title cannot be empty' });
      return;
    }
    setForkingId(forkPrompt.template.id);
    try {
      const res = await api.post<{ doc_id: string }>(
        `/templates/${encodeURIComponent(forkPrompt.template.id)}/fork`,
        { title },
      );
      navigate(`/docs/${res.doc_id}`);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Failed to fork template';
      toastStore.push({ kind: 'error', message });
    } finally {
      setForkingId(null);
      setForkPrompt(null);
    }
  };

  const create = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await api.post<{ id: string }>('/docs', {
        title: 'Untitled document',
        engine: newEngine,
      });
      navigate(`/docs/${res.id}`);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Failed to create document';
      toastStore.push({ kind: 'error', message });
    } finally {
      setCreating(false);
    }
  };

  const removeDoc = async (doc: DocSummary): Promise<void> => {
    setDeletingId(doc.id);
    try {
      await api.delete(`/docs/${encodeURIComponent(doc.id)}`);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== doc.id));
      setConfirmDeleteId(null);
      toastStore.push({ kind: 'success', message: `Deleted "${doc.title}"` });
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to delete document',
      });
    } finally {
      setDeletingId(null);
    }
  };

  // Archive (Active tab) and Unarchive (Archived tab) share the same
  // shape: POST then drop the row. The button glyph + tooltip swap
  // based on `view`. The server is authoritative on owner-or-admin —
  // editors/viewers will get a 403 toast, which mirrors how the
  // existing in-editor archive button behaves for non-owners.
  const toggleArchive = async (doc: DocSummary): Promise<void> => {
    const target = view === 'archived' ? 'unarchive' : 'archive';
    setArchivingId(doc.id);
    try {
      await api.post(`/docs/${encodeURIComponent(doc.id)}/${target}`);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== doc.id));
      toastStore.push({
        kind: 'success',
        message: target === 'archive' ? `Archived "${doc.title}"` : `Restored "${doc.title}"`,
      });
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : `Failed to ${target}`,
      });
    } finally {
      setArchivingId(null);
    }
  };

  if (session.status !== 'authenticated') {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <>
      <TopBar user={session.user} />
      <main className="mx-auto max-w-5xl px-8 py-12">
        <div className="mb-6 flex items-end justify-between border-b border-hairline pb-6">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-widest text-muted">
              // workspace
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-body">
              {view === 'archived' ? 'Archived documents' : 'Active documents'}
            </h1>
          </div>
          {view === 'active' && session.user.isAdmin ? (
            <div className="flex items-center gap-3">
              {/* The engine is fixed at creation — PATCH /docs/:id only
                  changes the title — so it has to be chosen here. Before
                  this control the button hardcoded latex, which made a
                  blank Typst document impossible to create: the only route
                  to one was forking a Typst template, and an admin had to
                  author that template first. */}
              {/* Plain toggle buttons with aria-pressed rather than a
                  radiogroup: two radios would need roving focus and arrow
                  keys to be correct, and two pressed buttons say the same
                  thing with the keyboard behaviour buttons already have. */}
              <div
                className="inline-flex items-center gap-px rounded border border-hairline-strong bg-surface p-0.5 font-mono text-[11px] uppercase tracking-wider"
                role="group"
                aria-label="Engine for the new document"
                data-testid="new-doc-engine"
              >
                {(['latex', 'typst'] as const).map((eng) => (
                  <button
                    key={eng}
                    type="button"
                    aria-pressed={newEngine === eng}
                    onClick={() => setNewEngine(eng)}
                    disabled={creating}
                    data-testid={`new-doc-engine-${eng}`}
                    className={`rounded-badge px-3 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      newEngine === eng
                        ? 'bg-inverse text-inverse-fg'
                        : 'text-body-2 hover:bg-page disabled:opacity-60'
                    }`}
                  >
                    {eng}
                  </button>
                ))}
              </div>
              <Button onClick={() => void create()} disabled={creating} data-testid="new-doc">
                {creating ? 'Creating…' : 'New document'}
              </Button>
            </div>
          ) : null}
        </div>
        <div
          className="mb-8 inline-flex items-center gap-px rounded border border-hairline-strong bg-surface p-0.5 font-mono text-[11px] uppercase tracking-wider"
          data-testid="workspace-tabs"
        >
          <button
            type="button"
            onClick={() => setView('active')}
            disabled={view === 'active'}
            data-testid="tab-active"
            className={
              view === 'active'
                ? 'cursor-default rounded-badge bg-inverse px-3 py-1 text-inverse-fg'
                : 'rounded-badge px-3 py-1 text-body-2 hover:bg-page'
            }
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => setView('archived')}
            disabled={view === 'archived'}
            data-testid="tab-archived"
            className={
              view === 'archived'
                ? 'cursor-default rounded-badge bg-inverse px-3 py-1 text-inverse-fg'
                : 'rounded-badge px-3 py-1 text-body-2 hover:bg-page'
            }
          >
            Archived
          </button>
        </div>
        {forkPrompt ? (
          <div
            className="mb-8 rounded-card border border-accent-border bg-accent-bg-alt p-5"
            data-testid="fork-prompt"
          >
            <div className="font-mono text-[10px] uppercase tracking-widest text-accent-fg-strong">
              // fork template · {forkPrompt.template.name}
            </div>
            <p className="mt-2 text-sm text-body-2">
              Pick a title for the new document. The default appends a Unix timestamp so two forks
              never collide.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <input
                autoFocus
                type="text"
                value={forkPrompt.title}
                maxLength={200}
                onChange={(e) =>
                  setForkPrompt((p) => (p === null ? null : { ...p, title: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitFork();
                  else if (e.key === 'Escape') setForkPrompt(null);
                }}
                aria-label="Title for the new document"
                className="flex-1 rounded border border-hairline-strong bg-surface px-3 py-2 font-mono text-[13px] text-body focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                data-testid="fork-prompt-title"
              />
              <Button
                variant="primary"
                onClick={() => void submitFork()}
                disabled={forkingId !== null || !forkPrompt.title.trim()}
                data-testid="fork-prompt-submit"
              >
                {forkingId === forkPrompt.template.id ? 'Forking…' : 'Create'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setForkPrompt(null)}
                disabled={forkingId !== null}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {view === 'active' && visibleTemplates.length > 0 ? (
          <section className="mb-10">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted">
                // templates
              </h2>
              <span className="font-mono text-[11px] text-muted" data-testid="templates-count">
                {visibleTemplates.length === 1
                  ? '1 template available'
                  : `${visibleTemplates.length} templates available`}
              </span>
            </div>
            <ul
              className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-hairline-strong bg-hairline-strong sm:grid-cols-2"
              data-testid="templates-list"
            >
              {visibleTemplates.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-4 bg-surface p-5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-body">{t.name}</div>
                    <div className="mt-1 font-mono text-[10px] tracking-widest text-muted">
                      {engineLabel(t.engine)}
                    </div>
                    {t.description ? (
                      <p className="mt-2 text-xs leading-relaxed text-body-2">{t.description}</p>
                    ) : null}
                  </div>
                  <Button
                    variant="mono"
                    onClick={() => openForkPrompt(t)}
                    disabled={forkingId !== null}
                    data-testid={`fork-template-${t.id}`}
                  >
                    {forkingId === t.id ? 'Forking…' : 'fork →'}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted">
              // {view === 'archived' ? 'archived' : 'active'} documents
            </h2>
            <span className="font-mono text-[11px] text-muted">{docs?.length ?? 0} total</span>
          </div>
          {docs === null ? (
            <p className="font-mono text-xs text-muted">Loading…</p>
          ) : docs.length === 0 ? (
            <div className="rounded-card border border-dashed border-hairline-strong bg-surface p-10 text-center">
              <p className="font-mono text-[11px] uppercase tracking-widest text-muted">// empty</p>
              <p className="mt-3 text-sm text-body-2">
                {view === 'archived' ? (
                  <>No archived documents. The Archive button on a document moves it here.</>
                ) : session.user.isAdmin ? (
                  <>
                    No documents yet. Hit{' '}
                    <span className="rounded-badge bg-fill-warm px-1.5 py-0.5 font-mono text-xs text-body-2">
                      New document
                    </span>{' '}
                    to create your first one.
                  </>
                ) : (
                  // Only admins have the New document button; telling
                  // everyone else to press it points at a control they
                  // cannot see.
                  <>No documents yet. An administrator can create one for you.</>
                )}
              </p>
            </div>
          ) : (
            <ul
              className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-hairline-strong bg-hairline-strong sm:grid-cols-2"
              data-testid="docs-list"
            >
              {docs.map((d) => (
                <li key={d.id} className="group relative bg-surface">
                  <Link to={`/docs/${d.id}`} className="block px-5 py-4 pr-12">
                    <div className="truncate text-sm font-semibold text-body">{d.title}</div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[10px] tracking-widest text-muted">
                      <span>{engineLabel(d.engine)}</span>
                    </div>
                  </Link>
                  {confirmDeleteId === d.id ? (
                    // Below the title rather than floating over it: the shared
                    // confirm carries a sentence, and a sentence on top of the
                    // card would hide what is about to be deleted.
                    <ConfirmInline
                      className="border-t border-hairline px-5 py-2"
                      message={`Delete “${d.title}”? This cannot be undone.`}
                      confirmLabel={deletingId === d.id ? 'Deleting…' : 'Delete'}
                      destructive
                      pending={deletingId === d.id}
                      onConfirm={() => void removeDoc(d)}
                      onCancel={() => setConfirmDeleteId(null)}
                      testId={`doc-delete-${d.id}`}
                    />
                  ) : (
                    <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => void toggleArchive(d)}
                        disabled={archivingId === d.id}
                        aria-busy={archivingId === d.id || undefined}
                        title={view === 'archived' ? 'Unarchive' : 'Archive'}
                        aria-label={`${view === 'archived' ? 'Unarchive' : 'Archive'} ${d.title}`}
                        data-testid={`doc-${view === 'archived' ? 'unarchive' : 'archive'}-${d.id}`}
                        className="rounded-badge p-1.5 text-muted transition-colors hover:bg-fill-hover hover:text-body-2"
                      >
                        {view === 'archived' ? (
                          // Inbox-arrow-up: take a doc OUT of the archive
                          <svg
                            className="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
                            <path d="M12 11V3" />
                            <path d="M9 6l3-3 3 3" />
                          </svg>
                        ) : (
                          // Box-arrow-down: archive
                          <svg
                            className="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M21 8H3v13h18V8z" />
                            <path d="M21 8l-2-5H5L3 8" />
                            <path d="M10 12h4" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(d.id)}
                        title="Delete"
                        aria-label={`Delete ${d.title}`}
                        data-testid={`doc-delete-${d.id}`}
                        className="rounded-badge p-1.5 text-muted transition-colors hover:bg-fill-hover hover:text-accent-text"
                      >
                        <svg
                          className="h-4 w-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
