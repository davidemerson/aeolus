// One-shot: for every doc_snapshots row with `bytes IS NULL`, fetch
// the blob from S3 and populate the column with its byteLength. The
// `bytes` column was added after the table already had rows in it; those
// written before then have NULL, which surfaces as "0 B" in the
// files-list UI (apps/api/src/routes/files.ts coalesces NULL → 0
// when summing snapshot bytes + tail update bytes). New snapshots
// populate `bytes` correctly via snapshotDoc; this fixes the long
// tail of older snapshots that haven't been re-written since.
//
// Safe to re-run; existing non-NULL rows are excluded by the WHERE
// clause. After this runs once successfully against a deployed env,
// the files panel shows real sizes for every text file.
//
// Usage:
//   DATABASE_URL=postgres://… \
//   AEOLUS_S3_BUCKET=aeolus-blobs \
//   AWS_REGION=us-east-2 \
//     pnpm --filter @aeolus/api exec tsx \
//       src/bin/backfill-snapshot-bytes.ts

import {
  S3BlobStore,
  backfillSnapshotBytes,
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

  console.log(`backfill-snapshot-bytes: bucket=${bucket}`);
  const start = Date.now();
  const report = await backfillSnapshotBytes(
    { db, blobs },
    { onProgress: (msg) => console.log(`  ${msg}`) },
  );
  const elapsedMs = Date.now() - start;
  console.log('');
  console.log(
    `scanned ${report.scanned} NULL-bytes row(s); ` +
      `wrote ${report.written}; skipped ${report.skipped} (${elapsedMs}ms)`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error('backfill-snapshot-bytes failed:', err);
  process.exit(1);
});
