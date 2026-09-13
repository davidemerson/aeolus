import { useCallback, useEffect, useState } from 'react';

import { toastStore } from '@aeolus/shared/ui';

import { api, ApiRequestError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRouter } from '../router.js';

// Server-side title length cap (apps/api/src/routes/docs.ts PatchDocBody).
// Mirrored here so the inline-rename input's maxLength keeps the user
// from typing past it before the PATCH would reject.
export const TITLE_MAX_LEN = 200;

export interface DocMetadata {
  // Loaded from GET /docs/:id. `title` is null until the request
  // completes — the view renders its own placeholder, so the literal
  // never leaks into the rename input or the download filename.
  // `docLoaded` flips once the doc + initial state are available,
  // gating downstream effects (auto-checkpoint, editor mount,
  // compile-poll) so they don't fire against stale state.
  title: string | null;
  engine: 'latex' | 'typst';
  archivedAt: string | null;
  docLoaded: boolean;
  // Inline title-rename UI state. `editingTitle` toggles between the
  // <h1> button and the <input>; `titleDraft` is the input's value;
  // `savingTitle` disables the input while the PATCH is in flight.
  editingTitle: boolean;
  titleDraft: string;
  savingTitle: boolean;
  setTitleDraft: (value: string) => void;
  startEditingTitle: () => void;
  commitTitle: () => Promise<void>;
  cancelTitle: () => void;
}

// Owns the GET /docs/:id load + the inline title-rename flow. Extracted
// from `apps/web/src/routes/doc-editor.tsx` (issue #46) so the route
// component stops being a 1400-line catch-all. Archive/unarchive
// toggling itself happens on the workspace list page, not here — this
// hook just exposes the read-side `archivedAt` so the editor can
// render the banner and lock the EditorView read-only.
export function useDocMetadata(id: string): DocMetadata {
  const session = useSession();
  const { navigate } = useRouter();
  const [title, setTitle] = useState<string | null>(null);
  const [engine, setEngine] = useState<'latex' | 'typst'>('latex');
  const [docLoaded, setDocLoaded] = useState(false);
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);

  useEffect(() => {
    if (session.status !== 'authenticated') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{
          doc: {
            title: string;
            engine: 'latex' | 'typst';
            archived_at: string | null;
          };
        }>(`/docs/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setTitle(res.doc.title);
        setEngine(res.doc.engine);
        setArchivedAt(res.doc.archived_at);
        setDocLoaded(true);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ApiRequestError ? err.message : 'Failed to load document';
        toastStore.push({ kind: 'error', message });
        navigate('/docs', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, session.status, navigate]);

  const startEditingTitle = useCallback(() => {
    if (title === null) return;
    setTitleDraft(title);
    setEditingTitle(true);
  }, [title]);

  const commitTitle = useCallback(async () => {
    const trimmed = titleDraft.trim().slice(0, TITLE_MAX_LEN);
    if (trimmed.length === 0 || trimmed === title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      await api.patch(`/docs/${encodeURIComponent(id)}`, { title: trimmed });
      setTitle(trimmed);
      setEditingTitle(false);
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to rename document',
      });
    } finally {
      setSavingTitle(false);
    }
  }, [id, title, titleDraft]);

  const cancelTitle = useCallback(() => {
    setEditingTitle(false);
    setTitleDraft('');
  }, []);

  return {
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
  };
}
