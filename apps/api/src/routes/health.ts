import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

// Liveness probe. Must return 200 whenever the
// process is up, irrespective of database / blob-store / queue state.
// Never point the ALB at /readyz, or a transient DB blip drains the
// whole service.
//
// /readyz (ADR 0024) answers the other question — can this process do
// its job right now — by touching Postgres and the blob store. Results
// are cached for READYZ_CACHE_MS so a probe every few seconds costs the
// dependencies nothing measurable.

const READYZ_CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

export interface ReadyzReport {
  ok: boolean;
  checks: { db: boolean; blobs: boolean };
  checkedAt: string;
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} probe timed out`)), PROBE_TIMEOUT_MS).unref(),
    ),
  ]);
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true }));

  let cached: ReadyzReport | null = null;
  let cachedAt = 0;

  // Written once per process so the GET below proves PutObject *and*
  // GetObject work with this task's role. The bucket policy grants object
  // actions only, so a GET of a key that does not exist is a 403, not a
  // clean miss — hence a real object rather than a "does the bucket
  // answer" call.
  const probeKey = `_readyz/api-${process.pid}`;
  let probeWritten = false;

  app.get('/readyz', async (_request, reply) => {
    const now = Date.now();
    if (cached && now - cachedAt < READYZ_CACHE_MS) {
      return reply.status(cached.ok ? 200 : 503).send(cached);
    }
    const checks = { db: false, blobs: false };
    try {
      await withTimeout(app.ctx.db.execute(sql`select 1`), 'db');
      checks.db = true;
    } catch (err) {
      app.log.warn({ err }, 'readyz: db probe failed');
    }
    try {
      if (!probeWritten) {
        await withTimeout(app.ctx.blobs.put(probeKey, Buffer.from('ok')), 'blobs put');
        probeWritten = true;
      }
      const body = await withTimeout(app.ctx.blobs.get(probeKey), 'blobs get');
      checks.blobs = body !== null;
    } catch (err) {
      app.log.warn({ err }, 'readyz: blob-store probe failed');
    }
    cached = { ok: checks.db && checks.blobs, checks, checkedAt: new Date(now).toISOString() };
    cachedAt = now;
    return reply.status(cached.ok ? 200 : 503).send(cached);
  });
}
