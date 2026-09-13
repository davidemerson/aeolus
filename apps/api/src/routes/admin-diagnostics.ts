import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { COMPILE_QUEUE_NAME } from '@aeolus/compile-worker';
import { loadDoc, persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { compileResults, docUpdates, type Database } from '@aeolus/db';
import { z } from 'zod';
import * as Y from 'yjs';

import { runBlobGc } from '../blob-gc.js';
import { makeRequireAdmin } from '../middleware/require-admin.js';
import { sendError } from '../middleware/reply-errors.js';
import { sessionConstants } from '@aeolus/auth';
import { createDoc, deleteDoc } from '../services/docs.js';
import { enqueueCompile } from '../services/compile.js';
import { serviceContext, sessionActor } from '../services/context.js';

const SMOKE_LATEX_SOURCE = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Hello from Aeolus. $a^2 + b^2 = c^2$.',
  '\\end{document}',
  '',
].join('\n');

interface QueueStats {
  queue: string;
  total_jobs: number;
  jobs_in_last_hour: number;
  oldest_unfinished_seconds: number | null;
}

interface CompileSnapshot {
  recent_total: number;
  by_status: Record<string, number>;
  oldest_queued_seconds: number | null;
  most_recent: Array<{
    job_id: string;
    status: string;
    error_first_line: string | null;
    age_seconds: number;
  }>;
}

/**
 * Where api fetches ws's diagnostics ring from. Defaults to the compose
 * service name, which is what a stock install has.
 *
 * The api makes this request itself, with the operator's configuration behind
 * it, so the check is a sanity check and not an authorization boundary: an
 * http(s) URL with a host and no credentials or path. Rejecting the rest keeps
 * a typo from turning an admin page into a request to something unintended.
 */
export function wsInternalBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AEOLUS_WS_INTERNAL_URL ?? 'http://ws:8080';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AEOLUS_WS_INTERNAL_URL is not a URL (got ${raw})`);
  }
  const wellFormed =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname.length > 0 &&
    url.username === '' &&
    url.password === '';
  if (!wellFormed) {
    throw new Error(
      `AEOLUS_WS_INTERNAL_URL must be an http(s) URL with no credentials (got ${raw})`,
    );
  }
  return url.origin;
}

async function snapshotQueue(
  db: Database,
  log: FastifyBaseLogger,
): Promise<QueueStats | { error: string }> {
  // pg-boss creates the pgboss schema lazily; if it isn't there we
  // surface that explicitly so the operator knows enqueue is broken
  // even if everything else looks healthy.
  try {
    const exists = await db.execute(
      sql`select 1 from information_schema.schemata where schema_name = 'pgboss'`,
    );
    if (exists.rowCount === 0) {
      return { error: 'pgboss schema not present (worker / api never started?)' };
    }
    const totalRows = await db.execute(
      sql`select count(*)::int as c from pgboss.job where name = ${COMPILE_QUEUE_NAME}`,
    );
    const lastHour = await db.execute(
      sql`select count(*)::int as c from pgboss.job
          where name = ${COMPILE_QUEUE_NAME}
          and created_on > now() - interval '1 hour'`,
    );
    const oldest = await db.execute(
      sql`select extract(epoch from (now() - created_on))::int as s
          from pgboss.job
          where name = ${COMPILE_QUEUE_NAME}
          and state in ('created','retry','active')
          order by created_on asc limit 1`,
    );
    return {
      queue: COMPILE_QUEUE_NAME,
      total_jobs: Number((totalRows.rows[0] as { c: number } | undefined)?.c ?? 0),
      jobs_in_last_hour: Number((lastHour.rows[0] as { c: number } | undefined)?.c ?? 0),
      oldest_unfinished_seconds: (oldest.rows[0] as { s: number } | undefined)?.s ?? null,
    };
  } catch (err) {
    // The message stays in the log — a Postgres error string is not
    // something to render in an admin page.
    log.warn({ err }, 'diagnostics: pgboss schema query failed');
    return { error: 'failed to query the pgboss schema (see the api log)' };
  }
}

async function snapshotCompiles(db: Database): Promise<CompileSnapshot> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const total = await db
    .select({ c: count() })
    .from(compileResults)
    .where(gt(compileResults.createdAt, since));
  const byStatus = await db
    .select({ status: compileResults.status, c: count() })
    .from(compileResults)
    .where(gt(compileResults.createdAt, since))
    .groupBy(compileResults.status);
  const oldestQueued = await db
    .select({
      created: compileResults.createdAt,
    })
    .from(compileResults)
    .where(eq(compileResults.status, 'queued'))
    .orderBy(compileResults.createdAt)
    .limit(1);
  const recent = await db
    .select({
      jobId: compileResults.jobId,
      status: compileResults.status,
      error: compileResults.error,
      createdAt: compileResults.createdAt,
    })
    .from(compileResults)
    .orderBy(desc(compileResults.createdAt))
    .limit(5);

  const summary: CompileSnapshot = {
    recent_total: total[0]?.c ?? 0,
    by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
    oldest_queued_seconds:
      oldestQueued.length > 0
        ? Math.floor((Date.now() - oldestQueued[0]!.created.getTime()) / 1000)
        : null,
    most_recent: recent.map((r) => ({
      job_id: r.jobId,
      status: r.status,
      error_first_line: r.error?.split('\n').find((s: string) => s.trim().length > 0) ?? null,
      age_seconds: Math.floor((Date.now() - r.createdAt.getTime()) / 1000),
    })),
  };
  return summary;
}

export async function registerAdminDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  const requireAdmin = makeRequireAdmin(app);

  // GET /admin/diagnostics — read-only system snapshot. Cheap, safe
  // to hit repeatedly. Tells the operator whether the queue + compile
  // table look like a working system, without enqueuing a job.
  app.get('/admin/diagnostics', { preHandler: requireAdmin }, async (request) => {
    const queue = await snapshotQueue(app.ctx.db, request.log);
    const compiles = await snapshotCompiles(app.ctx.db);

    // Server-side fetch of ws's diagnostics ring. The session cookie
    // the operator already sent us is valid for ws too (same
    // AEOLUS_COOKIE_SECRET signs both sides), so forward it. ws sits on a
    // different subdomain, so the browser would never send the cookie
    // there directly — proxying through api is the only path that
    // works without per-environment cookie-domain gymnastics.
    let ws: unknown;
    try {
      // Only the session cookie travels, and only to a URL that passed
      // wsInternalBase. Before this the operator's entire Cookie header was
      // forwarded to whatever AEOLUS_WS_INTERNAL_URL said — a misconfigured
      // value would have exfiltrated a live admin session.
      const wsBase = wsInternalBase();
      const session = request.cookies[sessionConstants.COOKIE_NAME];
      const wsRes = await fetch(`${wsBase}/diagnostics`, {
        headers: session ? { cookie: `${sessionConstants.COOKIE_NAME}=${session}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      const text = await wsRes.text();
      ws = {
        status: wsRes.status,
        body: (() => {
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        })(),
      };
    } catch (err) {
      request.log.warn({ err }, 'diagnostics: ws fetch failed');
      ws = { error: 'ws diagnostics unreachable (see the api log)' };
    }

    return {
      ts: new Date().toISOString(),
      queue,
      compiles,
      compile_boss_attached: app.ctx.compileBoss !== null,
      ws,
    };
  });

  // POST /admin/diagnostics/compile — runs a known-good LaTeX
  // smoke compile through the same pipeline a user's compile would
  // hit, and returns the full result inline. The point is to give
  // the operator a yes/no answer to "is the worker actually
  // compiling anything" without having to mint a doc, sign in
  // separately, hand the raw job_id around, etc. The seeded doc is
  // tagged with title ER-DIAGNOSTIC-<ts> so it's easy to find +
  // delete; the route soft-deletes it on the way out either way.
  app.post('/admin/diagnostics/compile', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = request.adminUser;
    if (!admin) {
      return sendError(reply, 401, 'unauthenticated', 'Not signed in');
    }
    if (!app.ctx.compileBoss) {
      return sendError(
        reply,
        503,
        'compile_disabled',
        'compileBoss is not attached to this api process',
      );
    }

    // 1. Seed a temporary doc + Yjs state holding the smoke source. The
    //    doc is created through the same service the UI and /api/v1 use
    //    (ADR 0021), so the dual-write and the audit row come for free.
    const actor = sessionActor(admin);
    const ctx = serviceContext(app, request, actor);
    const doc = await createDoc(ctx, actor, {
      title: `ER-DIAGNOSTIC-${Date.now()}`,
      engine: 'latex',
    });

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');
    ydoc.transact(() => ytext.insert(0, SMOKE_LATEX_SOURCE));
    const update = Y.encodeStateAsUpdate(ydoc);
    const localTextLen = ytext.toString().length;
    ydoc.destroy();
    const crdtDeps: CrdtDeps = { db: app.ctx.db, blobs: app.ctx.blobs };
    await persistUpdate(crdtDeps, doc.id, 1n, update, admin.id);

    // Self-verify: read the row back inside the same process and
    // round-trip it through loadDoc. This isolates "did api persist
    // anything" from "did the worker load it correctly". The two
    // numbers should match the local Y.Doc length above; if
    // persisted_update_bytes==0 the bytea write failed silently;
    // if api_loaded_source_length==0 with persisted bytes>0, the
    // round-trip is broken (Yjs format / encoding).
    const persistedRow = await app.ctx.db
      .select({
        seq: docUpdates.seq,
        // raw byte length of the bytea column, computed server-side
        // so we don't have to ship the bytes back through the
        // driver.
        updateLen: sql<number>`length(${docUpdates.update})::int`,
      })
      .from(docUpdates)
      // yjs_doc_id is the per-Yjs-doc key after issue #9 phase 3.
      // For admin-diagnostics smoke compiles the just-created doc
      // has yjs_doc_id == doc.id (the dual-write above seeded a
      // doc_files row with that mapping).
      .where(eq(docUpdates.yjsDocId, doc.id))
      .orderBy(docUpdates.seq);
    const apiLoaded = await loadDoc(crdtDeps, doc.id);
    const apiLoadedSourceLength = apiLoaded.doc.getText('source').toString().length;
    apiLoaded.doc.destroy();

    // 2. Enqueue exactly the way POST /docs/:id/compile does — same
    //    service, same compile_results row, same rev derivation.
    const { job_id: jobId } = await enqueueCompile(ctx, actor, doc.id, app.ctx.compileBoss);

    // 3. Poll for the result. Worker mean-time-to-success is ~3-12s
    //    on a warmed cache; allow 60s so a cold first-deploy compile
    //    has room to fetch its bundle.
    const deadline = Date.now() + 60_000;
    let last: typeof compileResults.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const [row] = await app.ctx.db
        .select()
        .from(compileResults)
        .where(and(eq(compileResults.jobId, jobId), eq(compileResults.docId, doc.id)))
        .limit(1);
      last = row;
      if (row && (row.status === 'success' || row.status === 'failed')) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // 4. Soft-delete the smoke doc no matter what so the user's
    //    /docs page doesn't fill up with diagnostic noise. The
    //    associated compile_results row stays for forensics.
    await deleteDoc(ctx, actor, doc.id);

    const elapsedMs = last
      ? (last.finishedAt ?? new Date()).getTime() - last.startedAt.getTime()
      : null;

    return reply.send({
      ok: last?.status === 'success',
      doc_id: doc.id,
      job_id: jobId,
      status: last?.status ?? 'timeout',
      elapsed_ms: elapsedMs,
      pdf_key: last?.pdfKey ?? null,
      error: last?.error ?? null,
      // Persistence self-check — set BEFORE the worker even ran.
      // If `local_text_length` is the source length we expect but
      // `api_loaded_source_length` is 0, the round-trip through
      // bytea is broken. If both are nonzero but the worker still
      // says "document source is empty", the worker's pool sees a
      // different DB or an old-image worker is running.
      persistence: {
        local_text_length: localTextLen,
        local_update_bytes: update.byteLength,
        persisted_rows: persistedRow.length,
        persisted_update_bytes: persistedRow.reduce((acc, r) => acc + (r.updateLen ?? 0), 0),
        api_loaded_source_length: apiLoadedSourceLength,
      },
    });
  });

  // POST /admin/blob-gc — sweep the blob store for objects not
  // referenced by any of doc_files / doc_project_checkpoint_blobs /
  // doc_checkpoints / doc_snapshots / compile_results. Body
  // `{ dry_run: boolean }`. Dry-run reports what would be deleted
  // without touching S3 — operators run it dry first to sanity-
  // check the orphan list before flipping. Returns counts + the
  // orphan listing (capped to 1000 keys in the response so a
  // huge sweep doesn't blow out the response payload).
  const BlobGcBody = z
    .object({
      dry_run: z.boolean().optional(),
      prefix: z.string().max(256).optional(),
    })
    .default({});
  app.post('/admin/blob-gc', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = BlobGcBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'invalid_body', message: parsed.error.issues[0].message });
    }
    const dryRun = parsed.data.dry_run ?? true;
    const report = await runBlobGc(app.ctx.db, app.ctx.blobs, {
      dryRun,
      prefix: parsed.data.prefix,
    });
    return reply.send({
      dry_run: dryRun,
      scanned: report.scanned,
      referenced: report.referenced,
      orphan_count: report.orphans.length,
      bytes_freed: report.bytesFreed,
      // Cap the inline listing to keep the response bounded; the
      // GC ran the full set, this is just for an operator
      // eyeballing the orphan shape.
      orphans_sample: report.orphans.slice(0, 1000).map((o) => ({
        key: o.key,
        size: o.size,
      })),
    });
  });
}
