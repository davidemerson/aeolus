// Scenario-C recovery: re-materialize docs / doc_files / doc_snapshots
// from the S3 `blobs` bucket alone. Use when RDS is gone but the
// bucket survives.
//
// The importer logic lives in @aeolus/crdt/restore.ts; this is the
// thin CLI shim that wires up DB + S3 + reports the outcome. Lives
// under apps/api/src/bin/ to inherit the workspace's tsx + module
// resolution; existing scripts at /scripts/ can't import @aeolus/*
// packages without absolute-path workarounds.
//
// Usage (against a deployed env, with the bundle's secrets):
//   DATABASE_URL=postgres://… \
//   AEOLUS_S3_BUCKET=aeolus-blobs \
//   AWS_REGION=us-east-2 \
//     pnpm --filter @aeolus/api exec tsx src/bin/restore-from-s3.ts
//
// Idempotent: safe to re-run after partial completion. Existing rows
// (matched by id) are left alone; only missing rows are inserted.
//
// What it doesn't recover (per the runbook):
//   - doc_updates rows beyond the latest snapshot
//   - kind=blob asset files (separate workflow; not yet automated)
//   - templates, collaborators, audit_events, sessions
//   - per-file checkpoints, project checkpoints

import {
  S3BlobStore,
  restoreFromBlobStore,
  s3ClientConfigFromEnv,
  type BlobStore,
} from '@aeolus/crdt';
import { db as createDb } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const bucket = process.env.AEOLUS_S3_BUCKET;
  if (!bucket) {
    console.error('AEOLUS_S3_BUCKET is required.');
    process.exit(1);
  }

  // Migrations first — the target DB is presumed to be a fresh
  // instance (Scenario C) and needs the schema before we can
  // INSERT anything.
  await runMigrations(connectionString);
  const { db, pool } = createDb({ connectionString });

  const blobs: BlobStore = new S3BlobStore({ bucket, clientConfig: s3ClientConfigFromEnv() });

  console.log(`scenario-c: bucket=${bucket}`);
  const start = Date.now();
  const report = await restoreFromBlobStore(
    { db, blobs },
    { onProgress: (msg) => console.log(`  ${msg}`) },
  );
  const elapsedMs = Date.now() - start;

  console.log('');
  console.log(
    `scanned ${report.scanned} manifest(s); restored ${report.restored}; ` +
      `skipped ${report.skipped.length} (${elapsedMs}ms)`,
  );

  if (report.skipped.length > 0) {
    console.log('');
    console.log('Skipped:');
    for (const s of report.skipped) {
      console.log(`  ${s.yjsDocId} — ${s.reason}${s.detail ? ` (${s.detail})` : ''}`);
    }
  }

  // Summary by docId — multiple yjs_doc_ids can share a docId
  // when a project has multiple text files.
  const byDoc = new Map<string, string[]>();
  for (const f of report.files) {
    const list = byDoc.get(f.docId) ?? [];
    list.push(f.path);
    byDoc.set(f.docId, list);
  }
  if (byDoc.size > 0) {
    console.log('');
    console.log(`Restored ${byDoc.size} doc(s):`);
    for (const [docId, paths] of byDoc) {
      console.log(`  ${docId}: ${paths.join(', ')}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('restore-from-s3 failed:', err);
  process.exit(1);
});
