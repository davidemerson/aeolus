import { eq } from 'drizzle-orm';

import { docFiles, docs, users, type Database } from '@aeolus/db';

import type { BlobStore } from './blob.js';

// Sidecar manifest written next to each yjs_doc_id's snapshot folder
// in S3 so a Scenario-C recovery (full bundle rebuild from S3 only,
// RDS gone) can map each blob set back to its application-level
// shape (which doc it belongs to, what path, who owned it). Without
// this, the S3 keys carry only `yjs_doc_id` — there's no way to
// reconstruct `docs` / `doc_files` rows from S3 alone.
//
// Schema is versioned. Bump the literal when the field set changes;
// readers reject unknown versions so a partial rollout can't silently
// import garbage. Today there's only `1`, so the union has a single
// arm.
export interface SnapshotManifestV1 {
  schema: 1;
  // Identity, redundantly encoded — also implicit in the manifest's
  // S3 key. The redundancy lets the importer cross-check it found
  // the right manifest (a misrouted GET would surface immediately).
  yjsDocId: string;
  // Reconstructable `docs` row — owner email is the durable key
  // (uuid IDs may differ across DB recreations). importer falls
  // back to a stub user if this email isn't already in `users`.
  docId: string;
  title: string;
  engine: 'latex' | 'typst';
  ownerEmail: string;
  archivedAt: string | null;
  deletedAt: string | null;
  // Reconstructable `doc_files` row. kind is implicitly 'text'
  // because non-text files (blobs, folders) don't carry a yjs_doc_id
  // and therefore never get snapshots.
  path: string;
  // Manifest-write timestamp, for ordering / debugging. Not used in
  // import — the latest manifest wins regardless.
  writtenAt: string;
}

export type SnapshotManifest = SnapshotManifestV1;

// One manifest per yjs_doc_id, overwritten on each snapshot. The
// older snapshots in the same folder stay valid (they're recoverable
// against the current manifest's mapping); only the latest mapping
// is preserved here.
export function manifestKeyFor(yjsDocId: string): string {
  return `docs/${yjsDocId}/manifest.json`;
}

export interface ManifestDeps {
  db: Database;
  blobs: BlobStore;
}

// Best-effort manifest write called from snapshotDoc(). A failure
// here MUST NOT fail the snapshot — the snapshot's purpose is
// durability of the document content, and the manifest is durability
// of the *recoverability* of that content. If the manifest write
// fails, the next snapshot retries naturally; importers tolerate
// missing manifests by skipping that yjs_doc_id and logging.
//
// Returns true if the manifest was written, false if the
// corresponding doc_files / docs / users row was missing (legitimate
// in narrow races: a file deleted between snapshot scheduling and
// snapshot completion). Throws on actual write failure so the caller
// can log without conflating "no doc" with "S3 down."
export async function writeSnapshotManifest(
  deps: ManifestDeps,
  yjsDocId: string,
): Promise<boolean> {
  const [row] = await deps.db
    .select({
      docId: docFiles.docId,
      path: docFiles.path,
      title: docs.title,
      engine: docs.engine,
      archivedAt: docs.archivedAt,
      deletedAt: docs.deletedAt,
      ownerEmail: users.email,
    })
    .from(docFiles)
    .innerJoin(docs, eq(docs.id, docFiles.docId))
    .innerJoin(users, eq(users.id, docs.ownerId))
    .where(eq(docFiles.yjsDocId, yjsDocId))
    .limit(1);
  if (!row) return false;

  const manifest: SnapshotManifest = {
    schema: 1,
    yjsDocId,
    docId: row.docId,
    title: row.title,
    engine: row.engine === 'typst' ? 'typst' : 'latex',
    ownerEmail: row.ownerEmail,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    path: row.path,
    writtenAt: new Date().toISOString(),
  };

  await deps.blobs.put(manifestKeyFor(yjsDocId), Buffer.from(JSON.stringify(manifest)));
  return true;
}

// Read + parse + validate a manifest. Returns null on missing key
// or malformed payload; throws only on transport-level failures.
// Callers (importer, debug tools) treat null as "skip this
// yjsDocId" rather than fatal.
export async function readSnapshotManifest(
  blobs: BlobStore,
  yjsDocId: string,
): Promise<SnapshotManifest | null> {
  const bytes = await blobs.get(manifestKeyFor(yjsDocId));
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isManifest(parsed)) return null;
  return parsed;
}

function isManifest(v: unknown): v is SnapshotManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    m.schema === 1 &&
    typeof m.yjsDocId === 'string' &&
    typeof m.docId === 'string' &&
    typeof m.title === 'string' &&
    (m.engine === 'latex' || m.engine === 'typst') &&
    typeof m.ownerEmail === 'string' &&
    (m.archivedAt === null || typeof m.archivedAt === 'string') &&
    (m.deletedAt === null || typeof m.deletedAt === 'string') &&
    typeof m.path === 'string' &&
    typeof m.writtenAt === 'string'
  );
}
