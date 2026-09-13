import { sql } from 'drizzle-orm';

import type { Database } from '@aeolus/db';

/**
 * Tell `apps/ws` to drop its in-memory Y.Doc for a file, so live editors
 * re-bootstrap from the database and see a change made outside the CRDT
 * stream (issue #52).
 *
 * The channel name is duplicated in `apps/ws/src/server.ts` — a Postgres
 * NOTIFY channel is a string contract between two processes, and there is no
 * shared module either can import without one depending on the other.
 *
 * Best-effort by design. A failed NOTIFY costs an open editor a page reload;
 * the persisted update is committed either way, so failing the caller's write
 * because the notification did not land would be strictly worse.
 */
export const ROOM_EVICT_CHANNEL = 'aeolus_room_evict';

export async function evictRoom(
  db: Database,
  yjsDocId: string,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    await db.execute(sql`select pg_notify(${ROOM_EVICT_CHANNEL}, ${yjsDocId})`);
  } catch (err) {
    onError?.(err);
  }
}
