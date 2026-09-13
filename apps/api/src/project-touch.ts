import { eq } from 'drizzle-orm';

import { docs, type Database } from '@aeolus/db';

// Stamp `docs.updated_at` because the project's FILE SET changed — a text file
// or asset was added, renamed, or deleted.
//
// Text *edits* do not come through here: they land in doc_updates via the ws
// server and are tracked by their own timestamps. This is specifically about
// structural changes, and it exists because a max() over doc_files.updated_at
// cannot see a DELETE — removing a row can only lower the maximum. Without this
// stamp, deleting a chapter left every freshness check believing the project
// was unchanged since the last compile, so the editor would restore a PDF that
// still contained the deleted file and skip the recompile that would have
// removed it. See isCompileCurrent in routes/compile.ts (issue #72).
//
// It also makes `docs.updated_at` mean what the workspace list already implies
// by ordering on it: adding a chapter now moves the project up "recently
// modified", which it previously did not.
//
// Deliberately fire-and-forget-safe: callers await it, but a failure here must
// never fail the mutation that already succeeded — the caller's own error
// handling stays in charge of the response.
export async function touchProject(db: Database, docId: string): Promise<void> {
  try {
    await db.update(docs).set({ updatedAt: new Date() }).where(eq(docs.id, docId));
  } catch {
    // A missed stamp costs one unnecessary recompile, which is the safe
    // direction. Failing the request the user just made is not.
  }
}
