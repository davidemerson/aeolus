import { setTimeout as sleep } from 'node:timers/promises';

import { and, eq, ne } from 'drizzle-orm';
import PgBoss, { type Job } from 'pg-boss';

import { loadDoc, type BlobStore, type CrdtDeps } from '@aeolus/crdt';
import { compileResults, docFiles, docs, type Database } from '@aeolus/db';

import { formatCompileError } from './compile-error.js';
import { COMPILE_QUEUE_NAME, type CompileJobData, type CompileJobResult } from './protocol.js';
import { runCompile, type AssetFile, type SandboxConfig } from './runner.js';

// The ws server persists edits to doc_updates asynchronously and without a
// client-visible acknowledgement (fire-and-forget — see apps/ws/src/room.ts and
// the `void seq` in apps/ws/src/server.ts). A compile requested right after a
// keystroke can out-run that persist, so a document the user has clearly typed
// into can read back empty here. We tolerate that lag when materialising the
// source (below): ~1.5s is far more than a healthy single DB round-trip, but
// small enough that a genuinely empty document (e.g. compile-on-open on a
// brand-new doc) still fails responsively.
const EMPTY_SOURCE_RETRIES = 6;
const EMPTY_SOURCE_RETRY_MS = 250;

export interface CompileWorkerDeps {
  db: Database;
  boss: PgBoss;
  blobs: BlobStore;
  tectonicBin: string;
  typstBin: string;
  tectonicCacheDir?: string;
  // Landlock confinement for the engine. Unset = engine runs unconfined
  // (local tests). See SandboxConfig / ADR 0022.
  sandbox?: SandboxConfig;
  // Optional Tectonic bundle source — issue #11. When set, passed
  // through to every compile via runCompile so the worker doesn't
  // depend on the public relay. Operators populate this from the
  // AEOLUS_TECTONIC_BUNDLE env var; see
  // docs/RUNBOOKS/tectonic-bundle.md.
  tectonicBundle?: string;
  timeoutMs?: number;
  workdirBase?: string;
  concurrency?: number;
  pdfKeyFor?: (docId: string, rev: string) => string;
  // How long close() waits for in-flight compiles before giving up.
  // Default 25 s: ECS SIGKILLs a task 30 s after SIGTERM unless the
  // manifest raises stopTimeout, and the aeolus manifest does not.
  drainTimeoutMs?: number;
  // Structured error sink for failures that are not the author's
  // (S3, DB, engine launch). Default: one JSON line on stderr.
  logError?: (detail: Record<string, unknown>, msg: string) => void;
}

export interface CompileWorkerHandle {
  workerId: string;
  // Number of compiles currently being processed.
  inFlight(): number;
  // Stop taking jobs, then wait for the in-flight ones — bounded by
  // drainTimeoutMs. Before 2026-09-13 this returned as soon as the
  // pg-boss subscription was off, and the launcher's process.exit()
  // killed the running engines; their compile_results rows stayed
  // `running` forever.
  close(): Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

const defaultLogError: NonNullable<CompileWorkerDeps['logError']> = (detail, msg) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', source: 'compile-worker', msg, ...detail })}\n`,
  );
};

const DEFAULT_CONCURRENCY = 2;

export async function createCompileWorker(deps: CompileWorkerDeps): Promise<CompileWorkerHandle> {
  const crdtDeps: CrdtDeps = { db: deps.db, blobs: deps.blobs };
  const pdfKeyFor =
    deps.pdfKeyFor ?? ((docId: string, rev: string) => `compiled/${docId}/${rev}.pdf`);

  await deps.boss.createQueue(COMPILE_QUEUE_NAME);

  const inFlight = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>): Promise<unknown> => {
    inFlight.add(promise);
    return promise.finally(() => inFlight.delete(promise));
  };

  const workerId = await deps.boss.work<CompileJobData>(
    COMPILE_QUEUE_NAME,
    {
      batchSize: deps.concurrency ?? DEFAULT_CONCURRENCY,
    },
    async (jobs: Job<CompileJobData>[]) => {
      // pg-boss v10 hands work() handlers a batch; process them in
      // parallel so concurrency matches the configured batchSize.
      await Promise.all(jobs.map((job) => track(processJob(deps, crdtDeps, pdfKeyFor, job))));
    },
  );

  return {
    workerId,
    inFlight: () => inFlight.size,
    async close() {
      await deps.boss.offWork(workerId);
      if (inFlight.size === 0) return;
      const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      const drained = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => true),
        sleep(drainTimeoutMs, false),
      ]);
      if (!drained) {
        (deps.logError ?? defaultLogError)(
          { inFlight: inFlight.size, drainTimeoutMs },
          'drain timeout; compiles still running will be killed with the process',
        );
      }
    },
  };
}

async function processJob(
  deps: CompileWorkerDeps,
  crdtDeps: CrdtDeps,
  pdfKeyFor: (docId: string, rev: string) => string,
  job: Job<CompileJobData>,
): Promise<CompileJobResult | void> {
  const { docId, engine, rev } = job.data;
  const jobId = job.id;

  await markStatus(deps.db, jobId, 'running', null);

  const [docRow] = await deps.db
    .select({
      id: docs.id,
      engine: docs.engine,
      deletedAt: docs.deletedAt,
    })
    .from(docs)
    .where(eq(docs.id, docId))
    .limit(1);
  if (!docRow) {
    return failJob(deps, rev, jobId, 'document not found');
  }
  if (docRow.deletedAt !== null) {
    return failJob(deps, rev, jobId, 'document is deleted');
  }
  if (docRow.engine !== engine) {
    return failJob(deps, rev, jobId, `engine mismatch: doc=${docRow.engine} job=${engine}`);
  }

  // Phase 2 of issue #9: walk doc_files to find the source entrypoint
  // and the blob assets. The migration backfilled every doc with a
  // 'main.{tex,typ}' text row pointing at docs.id (so the existing
  // per-doc Yjs state is the source of truth), and the API
  // dual-writes new docs / assets, so doc_files is always populated.
  const entrypointPath = engine === 'typst' ? 'main.typ' : 'main.tex';
  const [textRow] = await deps.db
    .select({ yjsDocId: docFiles.yjsDocId })
    .from(docFiles)
    .where(
      and(eq(docFiles.docId, docId), eq(docFiles.kind, 'text'), eq(docFiles.path, entrypointPath)),
    )
    .limit(1);
  if (!textRow || textRow.yjsDocId == null) {
    return failJob(deps, rev, jobId, `entrypoint ${entrypointPath} not found in doc_files`);
  }

  const loaded = await loadDoc(crdtDeps, textRow.yjsDocId);
  let source = loaded.doc.getText('source').toString();
  loaded.doc.destroy();

  // An empty read right after typing is almost always the doc_updates INSERT
  // not having landed yet (async persist), not a genuinely empty document.
  // Re-hydrate from the DB a few times before giving up, so a just-typed
  // compile doesn't fail with the misleading "document source is empty" (which
  // the user sees as "it compiled but there's no PDF"). See EMPTY_SOURCE_* above.
  for (let attempt = 0; source.length === 0 && attempt < EMPTY_SOURCE_RETRIES; attempt += 1) {
    await sleep(EMPTY_SOURCE_RETRY_MS);
    const reloaded = await loadDoc(crdtDeps, textRow.yjsDocId);
    source = reloaded.doc.getText('source').toString();
    reloaded.doc.destroy();
  }

  if (source.length === 0) {
    return failJob(deps, rev, jobId, 'document source is empty');
  }

  const blobRows = await deps.db
    .select({
      path: docFiles.path,
      filename: docFiles.filename,
      storageKey: docFiles.storageKey,
    })
    .from(docFiles)
    .where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'blob')));

  // Fetch every asset blob in parallel. Each row is an independent
  // S3 GET, so awaiting them serially scales linearly with asset
  // count and dominates cold-cache compile latency for any doc with
  // more than a handful of figures or fonts.
  const fetched = await Promise.all(
    blobRows.map(async (row) => ({
      row,
      data: row.storageKey ? await deps.blobs.get(row.storageKey) : null,
    })),
  );
  const assets: AssetFile[] = [];
  const missing: string[] = [];
  for (const { row, data } of fetched) {
    const filename = row.filename ?? row.path.split('/').pop() ?? row.path;
    if (data) {
      assets.push({ path: row.path, filename, data });
    } else {
      // doc_files row exists but blob storage returned null. That's
      // an S3 inconsistency / bucket misconfiguration we want to
      // know about — silently dropping the file produces a baffling
      // "file not found" compile error.
      missing.push(row.path);
    }
  }

  // Materialise every SIBLING text file too — the doc may have
  // multiple .tex/.sty/.bib files that the entrypoint pulls in via
  // \input{}, \include{}, \bibliography{}, etc. Each carries its
  // own yjs_doc_id (UNIQUE per ADR 0013), so we hydrate each
  // separately and write its rendered source to the compile
  // workdir at the file's `path`. This is what fixes the user-
  // reported "main.tex doesn't see frontmatter.tex" — the
  // pre-fix worker only ever wrote main and the blob set, leaving
  // sibling tex files invisible to the compiler.
  const siblingTextRows = await deps.db
    .select({ path: docFiles.path, yjsDocId: docFiles.yjsDocId })
    .from(docFiles)
    .where(
      and(
        eq(docFiles.docId, docId),
        eq(docFiles.kind, 'text'),
        // entrypoint has its source already loaded above; siblings
        // are everything else.
        ne(docFiles.path, entrypointPath),
      ),
    );
  await Promise.all(
    siblingTextRows.map(async (row) => {
      if (!row.yjsDocId) return;
      const sib = await loadDoc(crdtDeps, row.yjsDocId);
      const text = sib.doc.getText('source').toString();
      sib.doc.destroy();
      const filename = row.path.split('/').pop() ?? row.path;
      assets.push({
        path: row.path,
        filename,
        data: Buffer.from(text, 'utf8'),
      });
    }),
  );

  const totalMaterialised = blobRows.length + siblingTextRows.length;
  if (totalMaterialised > 0) {
    process.stdout.write(
      `[compile-worker] doc=${docId} rev=${rev} materializing ${assets.length}/${totalMaterialised} files` +
        (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '') +
        ` — ${assets.map((a) => `${a.path}=${a.data.byteLength}B`).join(', ')}\n`,
    );
  }

  try {
    const result = await runCompile({
      engine,
      source,
      sandbox: deps.sandbox,
      tectonicBin: deps.tectonicBin,
      typstBin: deps.typstBin,
      tectonicCacheDir: deps.tectonicCacheDir,
      tectonicBundle: deps.tectonicBundle,
      timeoutMs: deps.timeoutMs,
      workdirBase: deps.workdirBase,
      assets,
    });
    const pdfKey = pdfKeyFor(docId, rev);
    await deps.blobs.put(pdfKey, result.pdf);

    // Upload the parsed synctex map alongside the PDF when present.
    // Same prefix scheme so the GC sweep treats them together.
    let synctexKey: string | null = null;
    if (result.synctex) {
      synctexKey = `compiled/${docId}/${rev}.synctex.json`;
      await deps.blobs.put(synctexKey, Buffer.from(JSON.stringify(result.synctex), 'utf8'));
    }

    await markStatus(deps.db, jobId, 'success', {
      pdfKey,
      error: null,
      synctexKey,
      warnings: result.warnings,
    });
    return { status: 'success', rev, pdfKey };
  } catch (err) {
    const { message, authorFault } = formatCompileError(err);
    if (!authorFault) {
      // The author sees the generic sentence; the operator gets the cause.
      (deps.logError ?? defaultLogError)(
        { docId, rev, jobId, err: err instanceof Error ? err.message : String(err) },
        'compile failed outside the engine',
      );
    }
    return failJob(deps, rev, jobId, message);
  }
}

async function failJob(
  deps: CompileWorkerDeps,
  rev: string,
  jobId: string,
  message: string,
): Promise<CompileJobResult> {
  await markStatus(deps.db, jobId, 'failed', { pdfKey: null, error: message });
  return { status: 'failed', rev, error: message };
}

async function markStatus(
  db: Database,
  jobId: string,
  status: 'running' | 'success' | 'failed',
  extras: {
    pdfKey?: string | null;
    error?: string | null;
    synctexKey?: string | null;
    warnings?: string[];
  } | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };
  if (status === 'success' || status === 'failed') {
    patch.finishedAt = new Date();
  }
  if (extras) {
    if (extras.pdfKey !== undefined) patch.pdfKey = extras.pdfKey;
    if (extras.error !== undefined) patch.error = extras.error;
    if (extras.synctexKey !== undefined) patch.synctexKey = extras.synctexKey;
    if (extras.warnings !== undefined) patch.warnings = extras.warnings;
  }
  await db.update(compileResults).set(patch).where(eq(compileResults.jobId, jobId));
}
