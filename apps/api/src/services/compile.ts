import { eq, sql } from 'drizzle-orm';
import type { Readable } from 'node:stream';

import { COMPILE_QUEUE_NAME, type CompileJobData } from '@aeolus/compile-worker';
import { getDocCurrentSeq, loadDoc } from '@aeolus/crdt';
import { compileResults, docFiles, docs } from '@aeolus/db';
import type PgBoss from 'pg-boss';

import type { Actor } from '../actor.js';
import { assertCanRead, DocNotFoundError } from '../acl.js';
import { buildZip, safeFilename, type ZipEntry } from '../zip.js';
import type { ServiceContext } from './context.js';
import { NotFoundError } from './errors.js';
import type { DocEngine } from './docs.js';

/**
 * Compilation: enqueueing a job, reading its result, and getting the bytes out.
 *
 * Shared by the browser plane and `/api/v1`.
 */

export class CompileUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'compile_unavailable';
  constructor() {
    super('Compile queue is not configured');
  }
}

export class UnsupportedEngineError extends Error {
  readonly statusCode = 409;
  readonly code = 'unsupported_engine';
  constructor(engine: string) {
    super(`Cannot compile engine ${engine}`);
  }
}

export class EnqueueFailedError extends Error {
  readonly statusCode = 500;
  readonly code = 'enqueue_failed';
  constructor() {
    super('Failed to enqueue compile job');
  }
}

/** `compile_results.status` is CHECK-constrained to these four in the schema. */
export type CompileStatus = 'queued' | 'running' | 'success' | 'failed';
const COMPILE_STATUSES: readonly string[] = ['queued', 'running', 'success', 'failed'];
function asStatus(v: string): CompileStatus {
  // Anything unrecognised reads as 'failed' rather than as a success — the
  // same fail-closed instinct as the token scope gate.
  return COMPILE_STATUSES.includes(v) ? (v as CompileStatus) : 'failed';
}

export interface EnqueuedCompile {
  job_id: string;
  doc_id: string;
  engine: DocEngine;
  rev: string;
  status: 'queued';
}

export interface CompileView {
  job_id: string;
  doc_id: string;
  engine: string;
  status: CompileStatus;
  rev: string;
  pdf_key: string | null;
  pdf_url: string | null;
  synctex_url: string | null;
  error: string | null;
  // Non-fatal findings on a successful compile (#80): today, fonts the PDF
  // references but does not embed. Empty on a clean compile and on
  // failures; never null on the wire.
  warnings: string[];
  started_at: string;
  finished_at: string | null;
}

export interface LatestCompileView {
  job_id: string;
  doc_id: string;
  engine: string;
  rev: string;
  pdf_url: string;
  finished_at: string | null;
  is_current: boolean;
  // See CompileView.warnings. Carried here so a reopened editor shows the
  // same warning the compile did.
  warnings: string[];
}

/**
 * Does the newest successful compile still match what the project contains?
 *
 * This gates whether compile-on-open can be skipped, so a wrong TRUE is the
 * expensive direction: it leaves a stale PDF on screen as the final answer in
 * a document tool. Every branch therefore fails toward FALSE — an unnecessary
 * compile costs seconds, a stale PDF costs trust in the preview.
 *
 * It cannot be a `rev` comparison. `rev` is MAX(seq) of the MAIN file's Yjs
 * doc only, and per ADR 0013 every sibling text file carries its own
 * `yjs_doc_id` — so editing chapter2.tex, or adding an image, does not move
 * it. Instead nothing about the project may be newer than the compile's
 * `finished_at`: any file's `doc_updates.created_at`, any
 * `doc_snapshots.updated_at`, or `docs.updated_at` (which the file routes
 * stamp, because a max() over `doc_files.updated_at` cannot see a DELETE).
 *
 * The comparison happens entirely inside SQL rather than round-tripping
 * `finished_at` through a JS Date: Postgres timestamptz keeps microseconds and
 * a Date keeps milliseconds, so a returned instant can sort up to 1 ms earlier
 * than the row it came from. Here that would only cause a spurious recompile,
 * but the class of bug is avoidable for free.
 */
export async function isCompileCurrent(
  ctx: ServiceContext,
  docId: string,
  jobId: string,
): Promise<boolean> {
  const result = await ctx.db.execute(sql`
    WITH compiled AS (
      SELECT finished_at FROM compile_results WHERE job_id = ${jobId} LIMIT 1
    )
    SELECT EXISTS (
      SELECT 1
        FROM doc_files f
        JOIN doc_updates u ON u.yjs_doc_id = f.yjs_doc_id
       WHERE f.doc_id = ${docId}
         AND u.created_at > (SELECT finished_at FROM compiled)
      UNION ALL
      SELECT 1
        FROM doc_files f
        JOIN doc_snapshots s ON s.yjs_doc_id = f.yjs_doc_id
       WHERE f.doc_id = ${docId}
         AND s.updated_at > (SELECT finished_at FROM compiled)
      UNION ALL
      SELECT 1
        FROM docs d
       WHERE d.id = ${docId}
         AND d.updated_at > (SELECT finished_at FROM compiled)
    ) AS changed,
    (SELECT finished_at IS NULL FROM compiled) AS unknown
  `);
  const row = result.rows[0] as { changed?: boolean; unknown?: boolean } | undefined;
  // No finish timestamp means nothing to compare against — and a NULL on the
  // right of `>` makes every predicate NULL, i.e. "no changes found", which
  // would read as current. Catch it explicitly; if we do not know, compile.
  if (!row || row.unknown !== false || typeof row.changed !== 'boolean') return false;
  return !row.changed;
}

/** Compiling a soft-deleted document makes no sense, and an admin can read one. */
async function assertCompilable(ctx: ServiceContext, actor: Actor, docId: string) {
  const doc = await assertCanRead(ctx.acl, actor.id, docId);
  if (doc.deletedAt !== null) throw new DocNotFoundError();
  return doc;
}

export async function enqueueCompile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  boss: PgBoss | null,
): Promise<EnqueuedCompile> {
  const doc = await assertCompilable(ctx, actor, docId);
  if (doc.engine !== 'latex' && doc.engine !== 'typst') {
    throw new UnsupportedEngineError(doc.engine);
  }
  if (!boss) throw new CompileUnavailableError();

  // Cheap MAX(seq) rather than a full loadDoc: the enqueue path needs the rev,
  // not a hydrated Y.Doc, and hydrating means a potentially multi-MB S3 GET
  // plus a per-update apply loop on every compile request.
  const rev = (await getDocCurrentSeq({ db: ctx.db }, docId)).toString();

  const data: CompileJobData = { docId, engine: doc.engine, rev, userId: actor.id };
  const jobId = await boss.send(COMPILE_QUEUE_NAME, data);
  if (!jobId) throw new EnqueueFailedError();

  await ctx.db.insert(compileResults).values({
    docId,
    jobId,
    engine: doc.engine,
    rev: BigInt(rev),
    status: 'queued',
  });

  return { job_id: jobId, doc_id: docId, engine: doc.engine, rev, status: 'queued' };
}

/**
 * The newest successful compile, or null when there has never been one.
 *
 * Null is a normal state, not an error — the editor fetches this on every
 * mount — so the routes render it as 204 per ADR 0018.
 */
export async function latestCompile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  presign?: (key: string) => Promise<string>,
  onPresignError?: (err: unknown) => void,
): Promise<LatestCompileView | null> {
  await assertCanRead(ctx.acl, actor.id, docId);

  const [row] = await ctx.db
    .select({
      jobId: compileResults.jobId,
      engine: compileResults.engine,
      rev: compileResults.rev,
      pdfKey: compileResults.pdfKey,
      finishedAt: compileResults.finishedAt,
      warnings: compileResults.warnings,
    })
    .from(compileResults)
    .where(
      sql`${compileResults.docId} = ${docId}
          AND ${compileResults.status} = 'success'
          AND ${compileResults.pdfKey} IS NOT NULL`,
    )
    .orderBy(sql`${compileResults.createdAt} DESC`)
    .limit(1);
  if (!row || !row.pdfKey) return null;

  let pdfUrl: string | null = null;
  if (presign) {
    try {
      pdfUrl = await presign(row.pdfKey);
    } catch (err) {
      onPresignError?.(err);
    }
  }
  pdfUrl ??= `/docs/${docId}/compile/${row.jobId}/download`;

  return {
    job_id: row.jobId,
    doc_id: docId,
    engine: row.engine,
    rev: row.rev.toString(),
    pdf_url: pdfUrl,
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
    is_current: await isCompileCurrent(ctx, docId, row.jobId),
    warnings: row.warnings ?? [],
  };
}

export async function getCompile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  jobId: string,
  presign?: (key: string) => Promise<string>,
  onPresignError?: (err: unknown) => void,
): Promise<CompileView> {
  await assertCanRead(ctx.acl, actor.id, docId);

  const [row] = await ctx.db
    .select({
      jobId: compileResults.jobId,
      docId: compileResults.docId,
      engine: compileResults.engine,
      status: compileResults.status,
      rev: compileResults.rev,
      pdfKey: compileResults.pdfKey,
      synctexKey: compileResults.synctexKey,
      error: compileResults.error,
      warnings: compileResults.warnings,
      startedAt: compileResults.startedAt,
      finishedAt: compileResults.finishedAt,
    })
    .from(compileResults)
    .where(eq(compileResults.jobId, jobId))
    .limit(1);
  // A job id from another document is a 404, not someone else's status.
  if (!row || row.docId !== docId) throw new NotFoundError();

  let pdfUrl: string | null = null;
  if (row.status === 'success' && row.pdfKey) {
    if (presign) {
      try {
        pdfUrl = await presign(row.pdfKey);
      } catch (err) {
        onPresignError?.(err);
      }
    }
    pdfUrl ??= `/docs/${docId}/compile/${jobId}/download`;
  }

  return {
    job_id: row.jobId,
    doc_id: row.docId,
    engine: row.engine,
    status: asStatus(row.status),
    rev: row.rev.toString(),
    pdf_key: row.pdfKey,
    pdf_url: pdfUrl,
    synctex_url:
      row.status === 'success' && row.synctexKey ? `/docs/${docId}/compile/${jobId}/synctex` : null,
    error: row.error,
    warnings: row.warnings ?? [],
    started_at: row.startedAt.toISOString(),
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/**
 * The newest successful compile's synctex map, or null.
 *
 * Null covers three cases the caller cannot act on differently: never
 * compiled, a typst document (typst emits no synctex, permanently), and a row
 * whose blob has gone. All render as 204 rather than 404 — 404 is reserved for
 * "no such document, or no access". As a 404 this logged a console error on
 * every mount of every typst document, which trains people to ignore the
 * console (ADR 0018).
 */
export async function latestSynctex(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
): Promise<Buffer | null> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const [row] = await ctx.db
    .select({ synctexKey: compileResults.synctexKey })
    .from(compileResults)
    .where(
      sql`${compileResults.docId} = ${docId}
          AND ${compileResults.status} = 'success'
          AND ${compileResults.synctexKey} IS NOT NULL`,
    )
    .orderBy(sql`${compileResults.createdAt} DESC`)
    .limit(1);
  if (!row || !row.synctexKey) return null;
  return (await ctx.blobs.get(row.synctexKey)) ?? null;
}

/** One compile's synctex map. Absent is a 404 here, unlike the `latest` route. */
export async function getSynctex(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  jobId: string,
): Promise<Buffer> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const [row] = await ctx.db
    .select({
      docId: compileResults.docId,
      status: compileResults.status,
      synctexKey: compileResults.synctexKey,
    })
    .from(compileResults)
    .where(eq(compileResults.jobId, jobId))
    .limit(1);
  if (!row || row.docId !== docId) throw new NotFoundError();
  if (row.status !== 'success' || !row.synctexKey) throw new NotFoundError();
  const bytes = await ctx.blobs.get(row.synctexKey);
  if (!bytes) throw new NotFoundError();
  return bytes;
}

export interface PdfStream {
  body: Readable;
  contentLength: number | null;
  filename: string;
}

/** The only way to the PDF bytes. The caller's session or token is the gate. */
export async function openCompiledPdf(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  jobId: string,
): Promise<PdfStream> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const [row] = await ctx.db
    .select({
      docId: compileResults.docId,
      status: compileResults.status,
      pdfKey: compileResults.pdfKey,
    })
    .from(compileResults)
    .where(eq(compileResults.jobId, jobId))
    .limit(1);
  if (!row || row.docId !== docId) throw new NotFoundError();
  if (row.status !== 'success' || !row.pdfKey) throw new NotFoundError();

  const obj = await ctx.blobs.getStream(row.pdfKey);
  if (!obj) throw new NotFoundError();
  return {
    body: obj.body as Readable,
    contentLength: obj.contentLength ?? null,
    filename: `${jobId}.pdf`,
  };
}

export interface ProjectArchive {
  bytes: Buffer;
  filename: string;
}

/**
 * Every file in the project, zipped. Text files render their current CRDT
 * state to UTF-8; blobs are copied verbatim.
 *
 * Built in memory, which is bounded indirectly by the 200 MB per-document
 * upload cap.
 */
export async function buildProjectZip(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  onMissingBlob?: (info: { storageKey: string; path: string }) => void,
): Promise<ProjectArchive> {
  const doc = await assertCanRead(ctx.acl, actor.id, docId);
  if (doc.deletedAt !== null) throw new DocNotFoundError();

  const [docRow] = await ctx.db
    .select({ title: docs.title })
    .from(docs)
    .where(eq(docs.id, docId))
    .limit(1);

  const fileRows = await ctx.db
    .select({
      path: docFiles.path,
      kind: docFiles.kind,
      yjsDocId: docFiles.yjsDocId,
      storageKey: docFiles.storageKey,
    })
    .from(docFiles)
    .where(eq(docFiles.docId, docId))
    .orderBy(docFiles.path);

  const entries: ZipEntry[] = [];
  for (const row of fileRows) {
    if (row.kind === 'text' && row.yjsDocId) {
      const { doc: ydoc } = await loadDoc({ db: ctx.db, blobs: ctx.blobs }, row.yjsDocId);
      entries.push({
        path: row.path,
        data: Buffer.from(ydoc.getText('source').toString(), 'utf8'),
      });
      ydoc.destroy();
    } else if (row.kind === 'blob' && row.storageKey) {
      const bytes = await ctx.blobs.get(row.storageKey);
      if (!bytes) {
        // A row pointing at a missing blob is a data-integrity bug; surface it
        // rather than emitting a silent empty entry.
        onMissingBlob?.({ storageKey: row.storageKey, path: row.path });
        continue;
      }
      entries.push({ path: row.path, data: bytes });
    }
  }

  return {
    bytes: buildZip(entries),
    filename: `${safeFilename(docRow?.title ?? '', docId)}.zip`,
  };
}
