import { useEffect } from 'react';

import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';

// Fires an auto-checkpoint POST whenever the user opens a file in
// the editor. Server-side coalescing (per user, per file, 5-minute
// window) plus 30-day retention live in
// apps/api/src/routes/checkpoints.ts; this hook only kicks the
// request and ignores failures so a flaky network or a 422 viewer
// response can't surface to the user. Skipped on archived docs
// (server would 422 anyway, but we short-circuit on the client to
// avoid the round-trip and a race-y banner state).
//
// Extracted from doc-editor.tsx (issue #46) — was a single useEffect
// inline; pulled out so the route component shrinks and the
// auto-checkpoint contract is named where future readers can find it.
export function useAutoCheckpoint(
  docId: string,
  currentFileId: string | null,
  archivedAt: string | null,
  docLoaded: boolean,
): void {
  const session = useSession();
  useEffect(() => {
    if (session.status !== 'authenticated') return;
    if (!docLoaded) return;
    if (archivedAt !== null) return;
    const fileQuery = currentFileId ? `?fileId=${encodeURIComponent(currentFileId)}` : '';
    void api
      .post(`/docs/${encodeURIComponent(docId)}/checkpoints${fileQuery}`, {
        auto: true,
      })
      .catch(() => {
        // Silent — auto-checkpoint failure must not surface to the
        // user. Common reasons: 422 archived (caught above but race-
        // y), 422 viewer (no write), transient network blip.
      });
  }, [docId, session.status, docLoaded, archivedAt, currentFileId]);
}
