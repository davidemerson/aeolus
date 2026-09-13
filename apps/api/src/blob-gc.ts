import { isNotNull } from 'drizzle-orm';

import type { BlobListing, BlobStore } from '@aeolus/crdt';
import {
  compileResults,
  docCheckpoints,
  docFiles,
  docProjectCheckpointBlobs,
  docSnapshots,
  type Database,
} from '@aeolus/db';

export interface BlobGcReport {
  scanned: number;
  referenced: number;
  orphans: BlobListing[];
  // Bytes freed when run with dryRun=false. 0 in dry-run mode.
  bytesFreed: number;
}

// Walk every object in the blob store and partition into
// referenced / orphan based on five tables that hold storage keys:
//   doc_files.storage_key                         — current blobs
//   doc_project_checkpoint_blobs.storage_key      — pinned blob set
//   doc_checkpoints.snapshot_key                  — Yjs snapshots
//   doc_snapshots.snapshot_key                    — compaction snaps
//   compile_results.pdf_key                       — compiled PDFs
// An object referenced by ANY of these surfaces stays. The rest
// are orphans the GC sweep can drop. When dryRun is true we
// return the orphan listing without deleting; when false we
// delete each orphan and report bytesFreed.
export async function runBlobGc(
  db: Database,
  blobs: BlobStore,
  opts: { dryRun: boolean; prefix?: string } = { dryRun: true },
): Promise<BlobGcReport> {
  const all = await blobs.list(opts.prefix);
  const referenced = await collectReferencedKeys(db);

  const orphans: BlobListing[] = [];
  let referencedCount = 0;
  for (const obj of all) {
    if (referenced.has(obj.key)) {
      referencedCount += 1;
    } else {
      orphans.push(obj);
    }
  }

  let bytesFreed = 0;
  if (!opts.dryRun) {
    for (const o of orphans) {
      try {
        await blobs.delete(o.key);
        bytesFreed += o.size;
      } catch (err) {
        // Continue past per-object failures so a partial S3 outage
        // doesn't prevent freeing every other orphan in the same
        // sweep. The next run will retry whichever ones remain.
        process.stderr.write(
          `${JSON.stringify({
            level: 'error',
            source: 'blob-gc',
            msg: 'delete failed',
            key: o.key,
            err: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
      }
    }
  }

  return {
    scanned: all.length,
    referenced: referencedCount,
    orphans,
    bytesFreed,
  };
}

async function collectReferencedKeys(db: Database): Promise<Set<string>> {
  // Five SELECTs in parallel. Each returns a single column; we
  // load them eagerly because the GC sweep is rare (admin-driven)
  // and the table sizes are bounded by the per-doc 200 MB cap +
  // a small per-doc Yjs / checkpoint footprint.
  const [fileRows, pinnedRows, cpRows, snapRows, pdfRows] = await Promise.all([
    db.select({ key: docFiles.storageKey }).from(docFiles).where(isNotNull(docFiles.storageKey)),
    db.select({ key: docProjectCheckpointBlobs.storageKey }).from(docProjectCheckpointBlobs),
    db.select({ key: docCheckpoints.snapshotKey }).from(docCheckpoints),
    db.select({ key: docSnapshots.snapshotKey }).from(docSnapshots),
    db
      .select({ key: compileResults.pdfKey })
      .from(compileResults)
      .where(isNotNull(compileResults.pdfKey)),
  ]);

  const out = new Set<string>();
  for (const set of [fileRows, pinnedRows, cpRows, snapRows, pdfRows]) {
    for (const row of set) {
      if (row.key != null) out.add(row.key);
    }
  }
  return out;
}
