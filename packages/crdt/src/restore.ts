import { eq, isNull } from 'drizzle-orm';
import * as Y from 'yjs';

import { docs, docFiles, docSnapshots, users, type Database } from '@aeolus/db';

import type { BlobStore } from './blob.js';
import { manifestKeyFor, readSnapshotManifest } from './manifest.js';

export interface RestoreDeps {
  db: Database;
  blobs: BlobStore;
}

export interface RestoreReport {
  scanned: number;
  restored: number;
  skipped: SkipReason[];
  // Map of doc_files paths re-established to their owning doc_id.
  // The order is the import order — useful when something looks
  // wrong post-restore.
  files: Array<{ docId: string; yjsDocId: string; path: string }>;
}

export interface SkipReason {
  yjsDocId: string;
  reason:
    | 'no_manifest'
    | 'manifest_invalid'
    | 'no_snapshot_blob'
    | 'snapshot_decode_failed'
    | 'doc_already_exists_with_conflicting_path';
  detail?: string;
}

export interface RestoreOptions {
  // Optional progress callback — useful when running interactively
  // against large buckets so the operator can confirm work is
  // happening. Default no-op.
  onProgress?: (msg: string) => void;
}

// Walk the BlobStore for every yjs_doc_id with a sidecar manifest
// (`docs/<id>/manifest.json`), fetch its latest `snap-*.ydoc`,
// decode it, and re-materialize the corresponding `docs` /
// `doc_files` / `doc_snapshots` rows in the (presumably empty) DB.
//
// What this DOES recover:
//   - the docs row (id, title, engine, archived/deleted flags)
//   - the doc_files row (one per yjs_doc_id with a manifest)
//   - the doc_snapshots row pointing at the latest blob
//   - a stub user row for the snapshot's owner if not present
//
// What this DOES NOT recover:
//   - doc_updates rows (they're not in S3; only the snapshot is).
//     Recovered docs land at their last-snapshot state.
//   - blob assets (kind='blob' files). Doable as a follow-up by
//     listing storage_key prefixes, but not in scope here.
//   - templates, collaborators, audit_events, sessions — none of
//     these have S3-side persistence.
//   - per-file checkpoints, project checkpoints — the snapshots
//     and metadata for these live in DB only and are gone.
//
// Idempotent: re-running against a partially-imported DB skips
// docs/doc_files/doc_snapshots rows that already exist. This lets
// the operator interrupt-and-resume safely.
export async function restoreFromBlobStore(
  deps: RestoreDeps,
  opts: RestoreOptions = {},
): Promise<RestoreReport> {
  const onProgress = opts.onProgress ?? (() => {});

  // Walk the bucket for every manifest.json under docs/. Each
  // manifest is the entry-point for one yjs_doc_id's recovery.
  const listing = await deps.blobs.list('docs/');
  const manifestKeys = listing.map((b) => b.key).filter((k) => k.endsWith('/manifest.json'));
  onProgress(`scanned ${manifestKeys.length} manifest(s) under docs/`);

  const skipped: SkipReason[] = [];
  const files: RestoreReport['files'] = [];
  let restored = 0;

  for (const key of manifestKeys) {
    const yjsDocId = key.slice('docs/'.length, -'/manifest.json'.length);
    const manifest = await readSnapshotManifest(deps.blobs, yjsDocId);
    if (!manifest) {
      skipped.push({ yjsDocId, reason: 'manifest_invalid' });
      continue;
    }

    // Find the latest snapshot blob for this yjs_doc_id. We only
    // restore the latest because doc_snapshots is one-row-per-
    // yjsDocId; older snap-*.ydoc files stay in S3 (versioning +
    // lifecycle GC them on their own schedule) but aren't
    // referenced after restore.
    const snapKeys = listing
      .map((b) => b.key)
      .filter((k) => k.startsWith(`docs/${yjsDocId}/snap-`) && k.endsWith('.ydoc'));
    if (snapKeys.length === 0) {
      skipped.push({ yjsDocId, reason: 'no_snapshot_blob' });
      continue;
    }
    const latestKey = pickLatestSnapKey(snapKeys);
    const latestSeq = parseSeqFromSnapKey(latestKey);
    const blob = await deps.blobs.get(latestKey);
    if (!blob) {
      skipped.push({
        yjsDocId,
        reason: 'no_snapshot_blob',
        detail: `key=${latestKey} listed but get returned null`,
      });
      continue;
    }

    // Decode the snapshot to verify it parses; we don't apply it
    // anywhere yet, but a malformed blob shouldn't get a docs row
    // pointing at it.
    try {
      const probe = new Y.Doc();
      Y.applyUpdate(probe, new Uint8Array(blob));
      probe.destroy();
    } catch (err) {
      skipped.push({
        yjsDocId,
        reason: 'snapshot_decode_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Owner: find or create. Email is the durable key — uuids may
    // differ across DB recreations. Stub users come back as
    // non-admin; an operator needs to elevate them by hand if
    // they were admin before.
    const ownerId = await ensureUser(deps.db, manifest.ownerEmail);

    // docs row (idempotent: keep existing if id matches).
    const [existingDoc] = await deps.db
      .select({ id: docs.id })
      .from(docs)
      .where(eq(docs.id, manifest.docId))
      .limit(1);

    if (!existingDoc) {
      await deps.db.insert(docs).values({
        id: manifest.docId,
        title: manifest.title,
        engine: manifest.engine,
        ownerId,
        archivedAt: manifest.archivedAt ? new Date(manifest.archivedAt) : null,
        deletedAt: manifest.deletedAt ? new Date(manifest.deletedAt) : null,
      });
    }

    // doc_files row (idempotent on yjs_doc_id, which is unique).
    const [existingFile] = await deps.db
      .select({ id: docFiles.id, path: docFiles.path })
      .from(docFiles)
      .where(eq(docFiles.yjsDocId, yjsDocId))
      .limit(1);

    if (existingFile) {
      if (existingFile.path !== manifest.path) {
        skipped.push({
          yjsDocId,
          reason: 'doc_already_exists_with_conflicting_path',
          detail: `existing=${existingFile.path} manifest=${manifest.path}`,
        });
        continue;
      }
    } else {
      await deps.db.insert(docFiles).values({
        docId: manifest.docId,
        path: manifest.path,
        kind: 'text',
        yjsDocId,
      });
    }

    // doc_snapshots row (idempotent on yjs_doc_id, unique constraint).
    const [existingSnap] = await deps.db
      .select({ yjsDocId: docSnapshots.yjsDocId })
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, yjsDocId))
      .limit(1);
    if (!existingSnap) {
      await deps.db.insert(docSnapshots).values({
        yjsDocId,
        snapshotSeq: latestSeq,
        snapshotKey: latestKey,
        bytes: blob.byteLength,
      });
    }

    files.push({ docId: manifest.docId, yjsDocId, path: manifest.path });
    restored += 1;
    onProgress(`restored yjsDocId=${yjsDocId} → docId=${manifest.docId} path=${manifest.path}`);
  }

  return { scanned: manifestKeys.length, restored, skipped, files };
}

function pickLatestSnapKey(keys: readonly string[]): string {
  let bestKey = keys[0];
  let bestSeq = parseSeqFromSnapKey(bestKey);
  for (const k of keys.slice(1)) {
    const seq = parseSeqFromSnapKey(k);
    if (seq > bestSeq) {
      bestKey = k;
      bestSeq = seq;
    }
  }
  return bestKey;
}

function parseSeqFromSnapKey(key: string): bigint {
  // `docs/<id>/snap-<seq>.ydoc` → bigint. Returns 0n on parse
  // failure so a single bad key doesn't crash the sweep.
  const m = key.match(/\/snap-(\d+)\.ydoc$/);
  if (!m) return 0n;
  try {
    return BigInt(m[1]);
  } catch {
    return 0n;
  }
}

async function ensureUser(db: Database, email: string): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({
      email,
      name: email,
      isAdmin: false,
    })
    .returning({ id: users.id });
  return created.id;
}

// Backfill helper: walk the database for every yjs_doc_id that has a
// snapshot but no manifest in S3, and write one. Intended as a
// one-shot for existing snapshots that pre-date the sidecar-manifest
// write (i.e. snapshots written before the writeSnapshotManifest
// call landed in snapshotDoc). After this runs once, every
// snapshotted yjs_doc_id has a manifest.
//
// Lives next to restoreFromBlobStore because the two share the same
// invariant (manifest.json present iff yjs_doc_id is recoverable
// from S3 alone).
export async function backfillManifests(
  deps: RestoreDeps,
  opts: RestoreOptions = {},
): Promise<{ scanned: number; written: number; skipped: number }> {
  const onProgress = opts.onProgress ?? (() => {});
  const rows = await deps.db.select({ yjsDocId: docSnapshots.yjsDocId }).from(docSnapshots);
  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    const existing = await deps.blobs.get(manifestKeyFor(row.yjsDocId));
    if (existing) {
      skipped += 1;
      continue;
    }
    // Reuse the same write helper used in the snapshot path so the
    // shape can't drift between live and backfill.
    const { writeSnapshotManifest } = await import('./manifest.js');
    const ok = await writeSnapshotManifest(deps, row.yjsDocId);
    if (ok) {
      written += 1;
      onProgress(`wrote manifest for yjsDocId=${row.yjsDocId}`);
    } else {
      skipped += 1;
    }
  }
  return { scanned: rows.length, written, skipped };
}

// Backfill helper: walk doc_snapshots for rows whose `bytes` column
// is NULL and populate it from the actual blob byteLength. Intended
// as a one-shot for snapshots written before the column existed (which
// added the column). After 0022, snapshotDoc populates bytes on
// every write — but rows from before 0022 stay NULL until something
// rewrites them. The file-size shown by GET /docs/:id/files reads
// from this column, so a NULL is what surfaces as "0 B" in the UI.
//
// Idempotent: re-running after a clean run finds nothing to do
// (`scanned` increments but `written` stays 0).
export async function backfillSnapshotBytes(
  deps: RestoreDeps,
  opts: RestoreOptions = {},
): Promise<{ scanned: number; written: number; skipped: number }> {
  const onProgress = opts.onProgress ?? (() => {});
  const rows = await deps.db
    .select({
      yjsDocId: docSnapshots.yjsDocId,
      snapshotKey: docSnapshots.snapshotKey,
    })
    .from(docSnapshots)
    .where(isNull(docSnapshots.bytes));
  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    const blob = await deps.blobs.get(row.snapshotKey);
    if (!blob) {
      // Snapshot row points at a missing blob — log + skip rather
      // than fail. Same shape as the importer's no_snapshot_blob
      // skip; this hints at a deeper data-integrity issue worth
      // investigating but isn't fatal to the backfill.
      onProgress(`skip yjsDocId=${row.yjsDocId} — blob missing at ${row.snapshotKey}`);
      skipped += 1;
      continue;
    }
    await deps.db
      .update(docSnapshots)
      .set({ bytes: blob.byteLength })
      .where(eq(docSnapshots.yjsDocId, row.yjsDocId));
    written += 1;
    onProgress(`bytes=${blob.byteLength} yjsDocId=${row.yjsDocId}`);
  }
  return { scanned: rows.length, written, skipped };
}
