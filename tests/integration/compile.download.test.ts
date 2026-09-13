import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { compileResults, db as makeDb, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: MemoryBlobStore;
  close(): Promise<void>;
}

async function setup(): Promise<Fixtures> {
  process.env.NODE_ENV = 'test';
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_test')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();
  const connectionString = postgres.getConnectionUri();
  await runMigrations(connectionString);
  const { db, pool } = makeDb({ connectionString });
  const blobs = new MemoryBlobStore();
  const app = await buildServer({
    db,
    blobs,
    cookieSecret: 'compile-download-test-secret',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    postgres,
    baseUrl,
    db,
    dbPool: pool,
    blobs,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function freshCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev sessions ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 fake pdf body\n%%EOF');

describe('GET /docs/:id/compile/:jobId/download', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  async function seedJob(opts: {
    status: 'success' | 'failed' | 'queued';
    withBlob?: boolean;
  }): Promise<{
    docId: string;
    jobId: string;
    ownerId: string;
    outsiderId: string;
    pdfKey: string;
  }> {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await fx.db
      .insert(users)
      .values({ email: `dl-owner-${suffix}@example.com`, isAdmin: false })
      .returning({ id: users.id });
    const [outsider] = await fx.db
      .insert(users)
      .values({ email: `dl-out-${suffix}@example.com`, isAdmin: false })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: `dl-${suffix}`, engine: 'latex', ownerId: owner.id })
      .returning({ id: docs.id });

    const jobId = `job-${suffix}`;
    const pdfKey = `compiled/${doc.id}/1.pdf`;
    if (opts.withBlob) {
      await fx.blobs.put(pdfKey, Buffer.from(PDF_BYTES));
    }
    await fx.db.insert(compileResults).values({
      docId: doc.id,
      jobId,
      engine: 'latex',
      rev: 1n,
      status: opts.status,
      pdfKey: opts.status === 'success' && opts.withBlob ? pdfKey : null,
    });
    return { docId: doc.id, jobId, ownerId: owner.id, outsiderId: outsider.id, pdfKey };
  }

  // Regression: `GET /api/compiled/*` used to stream any object under the
  // `compiled/` prefix with NO auth check at all — no session, no ACL, no doc
  // lookup. Anyone who could reach the ALB and knew (or guessed) a doc id could
  // pull its PDF. It survived because production never set `presignCompiledPdf`,
  // so nothing generated a URL pointing at it; its only consumer was a shim in
  // the e2e harness. Both are gone.
  //
  // The assertion is deliberately about bytes, not about the error envelope:
  // the house `{error:'not_found'}` shape comes from `setNotFoundHandler`,
  // which is registered only when the built SPA is present, so under test the
  // reply is Fastify's default 404 instead. What must hold in every
  // environment is that no PDF comes back.
  it('has no unauthenticated /api/compiled/* passthrough', async () => {
    const { ownerId, pdfKey } = await seedJob({ status: 'success', withBlob: true });
    // The blob really is there, so a 404 is the route being gone rather than
    // the object being missing.
    expect(await fx.blobs.getStream(pdfKey)).not.toBeNull();

    const suffix = pdfKey.slice('compiled/'.length);
    const cookie = await freshCookie(fx.baseUrl, ownerId);

    for (const headers of [undefined, { cookie }]) {
      const res = await fetch(`${fx.baseUrl}/api/compiled/${suffix}`, { headers });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('application/pdf');
      expect(await res.text()).not.toContain('%PDF-');
    }
  });

  it('streams the PDF bytes with attachment Content-Disposition by default', async () => {
    const { docId, jobId, ownerId } = await seedJob({ status: 'success', withBlob: true });
    const cookie = await freshCookie(fx.baseUrl, ownerId);

    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}/download`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PDF_BYTES);
  });

  it('serves inline when ?inline=1', async () => {
    const { docId, jobId, ownerId } = await seedJob({ status: 'success', withBlob: true });
    const cookie = await freshCookie(fx.baseUrl, ownerId);

    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}/download?inline=1`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('GET status returns the relative download URL on success', async () => {
    const { docId, jobId, ownerId } = await seedJob({ status: 'success', withBlob: true });
    const cookie = await freshCookie(fx.baseUrl, ownerId);

    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pdf_url: string | null };
    expect(body.pdf_url).toBe(`/docs/${docId}/compile/${jobId}/download`);
  });

  it('returns 404 when status is not success', async () => {
    const { docId, jobId, ownerId } = await seedJob({ status: 'failed', withBlob: false });
    const cookie = await freshCookie(fx.baseUrl, ownerId);

    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}/download`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the blob is missing even though status=success', async () => {
    const { docId, jobId, ownerId } = await seedJob({ status: 'success', withBlob: false });
    const cookie = await freshCookie(fx.baseUrl, ownerId);

    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}/download`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('rejects non-collaborators with 404 (ACL applied at /docs/:id)', async () => {
    const { docId, jobId, outsiderId } = await seedJob({ status: 'success', withBlob: true });
    const cookie = await freshCookie(fx.baseUrl, outsiderId);

    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}/download`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('requires a session cookie', async () => {
    const { docId, jobId } = await seedJob({ status: 'success', withBlob: true });
    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}/download`);
    expect(res.status).toBe(401);
  });
});
