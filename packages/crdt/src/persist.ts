import { and, asc, eq, lte, max, sql } from 'drizzle-orm';
import * as Y from 'yjs';

import { docSnapshots, docUpdates, type Database } from '@aeolus/db';

import type { BlobStore } from './blob.js';
import { writeSnapshotManifest } from './manifest.js';

export interface CrdtDeps {
  db: Database;
  blobs: BlobStore;
}

export interface LoadedDoc {
  doc: Y.Doc;
  nextSeq: bigint;
  snapshotSeq: bigint;
}

const LOAD_ORIGIN = Symbol('crdt-load');

// All public helpers below take a `yjsDocId` — the per-Yjs-doc
// identifier that the persistence layer keys on. For
// phase-1-backfilled rows yjsDocId == docs.id (the existing per-doc
// Yjs key); phase-3 file creation generates fresh UUIDs per text
// file. Callers in Aeolus pass whichever they have; the helpers
// don't care.
export async function loadDoc(deps: CrdtDeps, yjsDocId: string): Promise<LoadedDoc> {
  const doc = new Y.Doc();
  const [snap] = await deps.db
    .select({ seq: docSnapshots.snapshotSeq, key: docSnapshots.snapshotKey })
    .from(docSnapshots)
    .where(eq(docSnapshots.yjsDocId, yjsDocId))
    .limit(1);

  let snapshotSeq = 0n;
  if (snap) {
    snapshotSeq = snap.seq;
    const bytes = await deps.blobs.get(snap.key);
    if (bytes) {
      Y.applyUpdate(doc, new Uint8Array(bytes), LOAD_ORIGIN);
    }
  }

  const rows = await deps.db
    .select({ seq: docUpdates.seq, update: docUpdates.update })
    .from(docUpdates)
    .where(eq(docUpdates.yjsDocId, yjsDocId))
    .orderBy(asc(docUpdates.seq));

  let maxSeq = snapshotSeq;
  for (const row of rows) {
    Y.applyUpdate(doc, new Uint8Array(row.update), LOAD_ORIGIN);
    if (row.seq > maxSeq) maxSeq = row.seq;
  }

  return { doc, nextSeq: maxSeq + 1n, snapshotSeq };
}

// Cheaply read the current rev (max seq) of a Yjs doc without
// hydrating the full Y.Doc. Equivalent to:
//   const { nextSeq } = await loadDoc(...);  return nextSeq - 1n;
// but skips the snapshot S3 GET and the per-update Y.applyUpdate
// loop. Used by enqueue paths (POST /docs/:id/compile) where the
// caller doesn't actually need the document, just the version.
export async function getDocCurrentSeq(deps: { db: Database }, yjsDocId: string): Promise<bigint> {
  const [[snap], [updates]] = await Promise.all([
    deps.db
      .select({ seq: docSnapshots.snapshotSeq })
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, yjsDocId))
      .limit(1),
    deps.db
      .select({ seq: max(docUpdates.seq) })
      .from(docUpdates)
      .where(eq(docUpdates.yjsDocId, yjsDocId)),
  ]);
  const snapshotSeq = snap?.seq ?? 0n;
  // drizzle's max() returns the column type which is bigint here,
  // but it's typed as `number | null` in the public API. The actual
  // runtime value when present is a bigint string from pg's COPY
  // protocol or a bigint from drizzle's bigint mode mapper.
  const updatesMax =
    updates?.seq == null ? 0n : typeof updates.seq === 'bigint' ? updates.seq : BigInt(updates.seq);
  return snapshotSeq > updatesMax ? snapshotSeq : updatesMax;
}

export async function persistUpdate(
  deps: CrdtDeps,
  yjsDocId: string,
  seq: bigint,
  update: Uint8Array,
  authorId: string | null,
): Promise<void> {
  await deps.db.insert(docUpdates).values({
    yjsDocId,
    seq,
    update: Buffer.from(update),
    authorId: authorId ?? null,
  });
}

export interface PendingUpdate {
  seq: bigint;
  update: Uint8Array;
  authorId: string | null;
}

// Persist a window of updates in a single multi-row INSERT. The
// per-room write loop (apps/ws/src/room.ts) coalesces every update
// queued during the previous DB round-trip into one of these calls,
// so under steady write load the cost per keystroke drops from
// "one INSERT per update" to "one INSERT per RTT * batch-size".
export async function persistUpdateBatch(
  deps: { db: Database },
  yjsDocId: string,
  batch: readonly PendingUpdate[],
): Promise<void> {
  if (batch.length === 0) return;
  await deps.db.insert(docUpdates).values(
    batch.map((b) => ({
      yjsDocId,
      seq: b.seq,
      update: Buffer.from(b.update),
      authorId: b.authorId ?? null,
    })),
  );
}

export interface SnapshotResult {
  snapshotSeq: bigint;
  snapshotKey: string;
  deletedRows: number;
}

export function snapshotKeyFor(yjsDocId: string, seq: bigint): string {
  // Key layout left as `docs/<id>/...` for backwards compatibility
  // with already-stored blobs. The `<id>` is now a yjs_doc_id, but
  // existing snap keys are valid since yjs_doc_id == docs.id for
  // phase-1-backfilled rows.
  return `docs/${yjsDocId}/snap-${seq.toString()}.ydoc`;
}

export async function snapshotDoc(
  deps: CrdtDeps,
  yjsDocId: string,
  doc: Y.Doc,
  upToSeq: bigint,
): Promise<SnapshotResult> {
  const encoded = Y.encodeStateAsUpdate(doc);
  const key = snapshotKeyFor(yjsDocId, upToSeq);
  await deps.blobs.put(key, Buffer.from(encoded));

  const bytes = encoded.byteLength;
  await deps.db
    .insert(docSnapshots)
    .values({ yjsDocId, snapshotSeq: upToSeq, snapshotKey: key, bytes })
    .onConflictDoUpdate({
      target: docSnapshots.yjsDocId,
      set: {
        snapshotSeq: upToSeq,
        snapshotKey: key,
        bytes,
        updatedAt: sql`now()`,
      },
    });

  const deleted = await deps.db
    .delete(docUpdates)
    .where(and(eq(docUpdates.yjsDocId, yjsDocId), lte(docUpdates.seq, upToSeq)))
    .returning({ id: docUpdates.id });

  // Sidecar manifest write — best-effort. Lets a Scenario-C
  // recovery (full bundle rebuild from S3 only, RDS gone) map this
  // yjs_doc_id back to its docs / doc_files state via
  // scripts/restore-from-s3.mjs. A write failure here does NOT fail
  // the snapshot: the snapshot's job is content durability, the
  // manifest is recoverability-of-that-content; the next snapshot
  // retries the manifest naturally, and the importer skips
  // yjs_doc_ids whose manifest is missing.
  try {
    await writeSnapshotManifest(deps, yjsDocId);
  } catch (err) {
    process.stderr.write(
      `[crdt] sidecar manifest write failed: yjsDocId=${yjsDocId} ` +
        `err=${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return { snapshotSeq: upToSeq, snapshotKey: key, deletedRows: deleted.length };
}

export const crdtLoadOrigin = LOAD_ORIGIN;
