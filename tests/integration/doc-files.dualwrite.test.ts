import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, docFiles, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
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
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'doc-files-test-secret',
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
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function freshUserAndCookie(fx: Fixtures): Promise<{ id: string; cookie: string }> {
  // Admin so POST /docs is allowed (issue #39 made non-admin POST /docs 403).
  const [user] = await fx.db
    .insert(users)
    .values({
      email: `dualwrite-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
      isAdmin: true,
    })
    .returning({ id: users.id });
  const res = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  if (res.status !== 201) throw new Error(`dev sessions ${res.status}`);
  const sc = res.headers.get('set-cookie');
  if (!sc) throw new Error('no set-cookie');
  const p = parseSetCookie(sc);
  if (!p) throw new Error('parse set-cookie');
  return { id: user.id, cookie: `${p.name}=${p.value}` };
}

describe('issue #9 — doc_files row creation on doc/asset operations', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('POST /docs creates a corresponding doc_files source row', async () => {
    const u = await freshUserAndCookie(fx);

    const latexRes = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie: u.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Latex doc', engine: 'latex' }),
    });
    expect(latexRes.status).toBe(201);
    const latex = (await latexRes.json()) as { id: string };
    const latexFiles = await fx.db
      .select({ path: docFiles.path, kind: docFiles.kind, yjsDocId: docFiles.yjsDocId })
      .from(docFiles)
      .where(eq(docFiles.docId, latex.id));
    expect(latexFiles).toHaveLength(1);
    expect(latexFiles[0].path).toBe('main.tex');
    expect(latexFiles[0].kind).toBe('text');
    expect(latexFiles[0].yjsDocId).toBe(latex.id);

    const typstRes = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie: u.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Typst doc', engine: 'typst' }),
    });
    expect(typstRes.status).toBe(201);
    const typst = (await typstRes.json()) as { id: string };
    const typstFiles = await fx.db
      .select({ path: docFiles.path })
      .from(docFiles)
      .where(eq(docFiles.docId, typst.id));
    expect(typstFiles[0].path).toBe('main.typ');
  });

  it('POST /docs/:id/assets mirrors into doc_files as a blob row', async () => {
    const u = await freshUserAndCookie(fx);
    const create = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie: u.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'asset host', engine: 'latex' }),
    });
    const { id: docId } = (await create.json()) as { id: string };

    // 1×1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      'base64',
    );
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' }));
    const upload = await fetch(`${fx.baseUrl}/api/docs/${docId}/assets`, {
      method: 'POST',
      headers: { cookie: u.cookie },
      body: fd,
    });
    expect(upload.status).toBe(201);

    const files = await fx.db
      .select({
        path: docFiles.path,
        kind: docFiles.kind,
        storageKey: docFiles.storageKey,
        sizeBytes: docFiles.sizeBytes,
      })
      .from(docFiles)
      .where(eq(docFiles.docId, docId));
    expect(files).toHaveLength(2);
    const blob = files.find((f) => f.kind === 'blob');
    expect(blob, 'blob row exists').toBeDefined();
    expect(blob!.path).toBe('logo.png');
    expect(blob!.storageKey).toMatch(/^assets\//);
    expect(blob!.sizeBytes).toBe(png.length);
  });

  it('duplicate filename uploads land at suffixed paths in doc_files', async () => {
    const u = await freshUserAndCookie(fx);
    const create = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie: u.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'dup host', engine: 'latex' }),
    });
    const { id: docId } = (await create.json()) as { id: string };

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      'base64',
    );
    for (let i = 0; i < 2; i += 1) {
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' }));
      const r = await fetch(`${fx.baseUrl}/api/docs/${docId}/assets`, {
        method: 'POST',
        headers: { cookie: u.cookie },
        body: fd,
      });
      expect(r.status).toBe(201);
    }

    const files = await fx.db
      .select({ path: docFiles.path, kind: docFiles.kind })
      .from(docFiles)
      .where(eq(docFiles.docId, docId));
    const blobPaths = files
      .filter((f) => f.kind === 'blob')
      .map((f) => f.path)
      .sort();
    expect(blobPaths).toEqual(['logo-2.png', 'logo.png']);
  });

  it('DELETE /docs/:id/assets/:assetId drops the matching doc_files row', async () => {
    const u = await freshUserAndCookie(fx);
    const create = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie: u.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'del host', engine: 'latex' }),
    });
    const { id: docId } = (await create.json()) as { id: string };

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      'base64',
    );
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(png)], 'pic.png', { type: 'image/png' }));
    const upload = await fetch(`${fx.baseUrl}/api/docs/${docId}/assets`, {
      method: 'POST',
      headers: { cookie: u.cookie },
      body: fd,
    });
    const uploaded = (await upload.json()) as { asset: { id: string } };

    const del = await fetch(`${fx.baseUrl}/api/docs/${docId}/assets/${uploaded.asset.id}`, {
      method: 'DELETE',
      headers: { cookie: u.cookie },
    });
    expect(del.status).toBe(204);

    const remaining = await fx.db
      .select({ kind: docFiles.kind })
      .from(docFiles)
      .where(eq(docFiles.docId, docId));
    // Only the source row survives.
    expect(remaining.map((r) => r.kind)).toEqual(['text']);
  });

  it('migration backfill: pre-existing docs end up with main.{tex,typ} rows', async () => {
    // Insert a doc directly (bypassing the API's dual-write) and
    // confirm the migration's "every doc gets a source row" invariant
    // holds for new rows by re-running the backfill statement-shape
    // via INSERT … ON CONFLICT DO NOTHING. (The migration itself is
    // already exercised by every other test that runs through
    // runMigrations; this case pins the corner where someone inserts
    // straight into docs and we still want a source row to appear.)
    const u = await freshUserAndCookie(fx);
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'no API', engine: 'latex', ownerId: u.id })
      .returning({ id: docs.id });
    // No doc_files row yet.
    const before = await fx.db
      .select({ id: docFiles.id })
      .from(docFiles)
      .where(eq(docFiles.docId, doc.id));
    expect(before).toHaveLength(0);
    // Backfill statement (mirrors the migration body).
    await fx.dbPool.query(
      `INSERT INTO doc_files (doc_id, path, kind, yjs_doc_id)
         SELECT id,
                CASE WHEN engine='typst' THEN 'main.typ' ELSE 'main.tex' END,
                'text', id
           FROM docs
          WHERE id = $1
        ON CONFLICT (doc_id, path) DO NOTHING`,
      [doc.id],
    );
    const after = await fx.db
      .select({ path: docFiles.path, kind: docFiles.kind })
      .from(docFiles)
      .where(eq(docFiles.docId, doc.id));
    expect(after).toEqual([{ path: 'main.tex', kind: 'text' }]);
  });
});
