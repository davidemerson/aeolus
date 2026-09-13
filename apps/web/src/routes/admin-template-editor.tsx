import { useEffect, useState } from 'react';

import { toastStore } from '@aeolus/shared/ui';

import { api, ApiRequestError, type Template } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRouter } from '../router.js';
import { DocEditorRoute } from './doc-editor.js';

export function AdminTemplateEditorRoute({ id }: { id: string }) {
  const session = useSession();
  const { navigate } = useRouter();
  const [template, setTemplate] = useState<Template | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
      return;
    }
    if (session.status === 'authenticated' && !session.user.isAdmin) {
      setDenied(true);
    }
  }, [session, navigate]);

  useEffect(() => {
    if (session.status !== 'authenticated' || !session.user.isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ template: Template }>(`/templates/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setTemplate(res.template);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ApiRequestError ? err.message : 'Failed to load template';
        toastStore.push({ kind: 'error', message });
        navigate('/admin/templates', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, session, navigate]);

  if (denied) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-center">
        <h1 className="text-xl font-semibold text-body">You can’t edit this template</h1>
        <p className="mt-2 text-sm text-muted">
          Only administrators can change templates. Ask one to make the edit for you.
        </p>
      </main>
    );
  }

  if (session.status !== 'authenticated' || !template) {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return <DocEditorRoute id={template.yjs_doc_id} />;
}
