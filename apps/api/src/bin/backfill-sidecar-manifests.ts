// One-shot: for every yjs_doc_id with a snapshot row but no
// `docs/<id>/manifest.json` in S3, write the manifest. Brings
// pre-sidecar-era snapshots into Scenario-C-recoverable shape.
//
// Safe to re-run; existing manifests are left alone. After this
// runs once successfully, every snapshotted yjs_doc_id has a
// manifest, and the importer (restore-from-s3) is fully effective.
//
// Usage (against a deployed env):
//   DATABASE_URL=postgres://… \
//   AEOLUS_S3_BUCKET=aeolus-blobs \
//   AWS_REGION=us-east-2 \
//     pnpm --filter @aeolus/api exec tsx src/bin/backfill-sidecar-manifests.ts

import {
  S3BlobStore,
  backfillManifests,
  s3ClientConfigFromEnv,
  type BlobStore,
} from '@aeolus/crdt';
import { db as createDb } from '@aeolus/db';

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

  const { db, pool } = createDb({ connectionString });
  const blobs: BlobStore = new S3BlobStore({ bucket, clientConfig: s3ClientConfigFromEnv() });

  console.log(`backfill: bucket=${bucket}`);
  const start = Date.now();
  const report = await backfillManifests(
    { db, blobs },
    { onProgress: (msg) => console.log(`  ${msg}`) },
  );
  const elapsedMs = Date.now() - start;
  console.log('');
  console.log(
    `scanned ${report.scanned} snapshot row(s); wrote ${report.written} manifest(s); ` +
      `skipped ${report.skipped} (${elapsedMs}ms)`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error('backfill-sidecar-manifests failed:', err);
  process.exit(1);
});
