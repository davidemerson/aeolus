import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore, persistUpdate } from '@aeolus/crdt';
import { compileResults, docFiles, docs, users, db as makeDb, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';

import { parseSetCookie } from './helpers/cookies.js';

// GET /docs/:id/compile/latest — the restore-on-mount endpoint (issue #72).
//
// The editor fetches this on mount so it can put the last successful PDF on
// screen immediately instead of leaving the preview empty until a fresh compile
// lands. `is_current` is the load-bearing field: it decides whether the
// compile-on-open can be skipped.
//
// A wrong `is_current: true` is the expensive direction — it would leave a
// stale PDF on screen as the final answer — so most of this file is about the
// ways a project can change that must each flip it to false. In particular it
// CANNOT be a `rev` comparison: rev is MAX(seq) of the MAIN file's Yjs doc, and
// every sibling text file has its own yjs_doc_id, so editing chapter2 or
// touching an asset never moves it.

const PUBLIC_BASE_URL = 'http://localhost:5173';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  app: FastifyInstance;
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
    cookieSecret: 'integration-test-secret-do-not-use',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: PUBLIC_BASE_URL,
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    postgres,
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    app,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function sessionCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev session failed: ${res.status}`);
  const parsed = parseSetCookie(res.headers.get('set-cookie') ?? '');
  if (!parsed) throw new Error('no set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

interface LatestBody {
  job_id: string;
  doc_id: string;
  engine: string;
  rev: string;
  pdf_url: string | null;
  finished_at: string | null;
  is_current: boolean;
}

let jobCounter = 0;

describe('GET /docs/:id/compile/latest', () => {
  let fx: Fixtures;
  let ownerCookie: string;
  let strangerCookie: string;
  let ownerId: string;

  // Seeds a doc with a main text file, mirroring what POST /docs does.
  async function seedDoc(engine: 'latex' | 'typst' = 'latex'): Promise<string> {
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: `Doc ${Date.now()}`, engine, ownerId })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: engine === 'typst' ? 'main.typ' : 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });
    return doc.id;
  }

  // A successful compile that finished `agoMs` ago.
  //
  // EVERY timestamp is set explicitly, including created_at: the endpoint
  // orders by created_at DESC, and two rows inserted in the same millisecond
  // would make "which is newest" a coin flip. Two consecutive now() reads share
  // a millisecond most of the time on a fast host, so this is not theoretical.
  //
  // It also backdates the DOC row to before the compile. That models reality —
  // a document exists before it is compiled — and without it every case would
  // report is_current: false, because seedDoc stamps docs.updated_at at now()
  // and the compile is deliberately in the past.
  async function seedCompile(
    docId: string,
    opts: { agoMs?: number; finishedAt?: Date | null } = {},
  ): Promise<string> {
    jobCounter += 1;
    const jobId = `00000000-0000-4000-8000-${String(jobCounter).padStart(12, '0')}`;
    const ago = opts.agoMs ?? 60_000;
    const startedAt = new Date(Date.now() - ago - 1_000);
    const finishedAt = opts.finishedAt === undefined ? new Date(Date.now() - ago) : opts.finishedAt;

    await fx.db
      .update(docs)
      .set({
        createdAt: new Date(Date.now() - ago - 10_000),
        updatedAt: new Date(Date.now() - ago - 10_000),
      })
      .where(eq(docs.id, docId));

    await fx.db.insert(compileResults).values({
      docId,
      engine: 'latex',
      jobId,
      rev: 1n,
      status: 'success',
      pdfKey: `compiled/${docId}/1.pdf`,
      synctexKey: null,
      error: null,
      startedAt,
      finishedAt,
      createdAt: startedAt,
      updatedAt: finishedAt ?? startedAt,
    });
    return jobId;
  }

  async function getLatest(docId: string, cookie = ownerCookie): Promise<Response> {
    return fetch(`${fx.baseUrl}/api/docs/${docId}/compile/latest`, {
      headers: { cookie },
    });
  }

  beforeAll(async () => {
    fx = await setup();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await fx.db
      .insert(users)
      .values({ email: `owner-${suffix}@example.com`, name: 'owner', isAdmin: false })
      .returning({ id: users.id });
    const [stranger] = await fx.db
      .insert(users)
      .values({ email: `str-${suffix}@example.com`, name: 'stranger', isAdmin: false })
      .returning({ id: users.id });
    ownerId = owner.id;
    ownerCookie = await sessionCookie(fx.baseUrl, owner.id);
    strangerCookie = await sessionCookie(fx.baseUrl, stranger.id);
  }, 120_000);

  afterAll(async () => {
    await fx?.close();
  });

  /* ---- status contract ------------------------------------------------- */

  it('answers 204 for a doc that has never compiled successfully', async () => {
    const docId = await seedDoc();
    const res = await getLatest(docId);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('ignores failed and queued compiles when picking the latest', async () => {
    const docId = await seedDoc();
    jobCounter += 1;
    await fx.db.insert(compileResults).values({
      docId,
      engine: 'latex',
      jobId: `00000000-0000-4000-8000-${String(jobCounter).padStart(12, '0')}`,
      rev: 1n,
      status: 'failed',
      pdfKey: null,
      error: 'boom',
    });
    expect((await getLatest(docId)).status).toBe(204);
  });

  it('returns the newest successful compile with a usable pdf_url', async () => {
    const docId = await seedDoc();
    await seedCompile(docId, { agoMs: 120_000 });
    const newest = await seedCompile(docId, { agoMs: 30_000 });

    const res = await getLatest(docId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LatestBody;
    expect(body.job_id).toBe(newest);
    expect(body.doc_id).toBe(docId);
    expect(body.pdf_url).toBe(`/docs/${docId}/compile/${newest}/download`);
    expect(body.finished_at).not.toBeNull();
  });

  it('404s for an unknown doc and does not answer 204 to a stranger', async () => {
    const docId = await seedDoc();
    await seedCompile(docId);
    expect((await getLatest('33333333-3333-4333-8333-333333333333')).status).toBe(404);
    expect([403, 404]).toContain((await getLatest(docId, strangerCookie)).status);
  });

  it('requires a session', async () => {
    const docId = await seedDoc();
    await seedCompile(docId);
    const res = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/latest`);
    expect(res.status).toBe(401);
  });

  // `latest` must not be swallowed by the /compile/:jobId parametric route.
  it('does not collide with the compile-status route', async () => {
    const docId = await seedDoc();
    const jobId = await seedCompile(docId);
    const status = await fetch(`${fx.baseUrl}/api/docs/${docId}/compile/${jobId}`, {
      headers: { cookie: ownerCookie },
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { job_id: string }).job_id).toBe(jobId);
    expect((await getLatest(docId)).status).toBe(200);
  });

  /* ---- is_current: the part that must never be wrong ------------------- */

  it('is_current is true when nothing has happened since the compile', async () => {
    const docId = await seedDoc();
    // seedCompile backdates the doc row too, so the project genuinely predates
    // the compile — the ordinary "opened a document I compiled earlier" case.
    await seedCompile(docId, { agoMs: 5_000 });
    const body = (await (await getLatest(docId)).json()) as LatestBody;
    expect(body.is_current).toBe(true);
  });

  it('is_current is false after an edit to the MAIN file', async () => {
    const docId = await seedDoc();
    await seedCompile(docId, { agoMs: 5_000 });
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'edited');
    await persistUpdate(
      { db: fx.db, blobs: new MemoryBlobStore() },
      docId,
      1n,
      Y.encodeStateAsUpdate(doc),
      ownerId,
    );
    doc.destroy();
    const body = (await (await getLatest(docId)).json()) as LatestBody;
    expect(body.is_current).toBe(false);
  });

  // THE case a rev comparison gets wrong. rev is MAX(seq) of main's Yjs doc;
  // a sibling text file has its own yjs_doc_id, so its edits never move rev.
  it('is_current is false after an edit to a SIBLING file, which rev cannot see', async () => {
    const docId = await seedDoc();
    const siblingYjsId = '44444444-4444-4444-8444-444444444444';
    await fx.db.insert(docFiles).values({
      docId,
      path: 'chapter2.tex',
      kind: 'text',
      yjsDocId: siblingYjsId,
    });
    await seedCompile(docId, { agoMs: 5_000 });

    // rev is unchanged by this edit — main was never touched.
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'chapter two');
    await persistUpdate(
      { db: fx.db, blobs: new MemoryBlobStore() },
      siblingYjsId,
      1n,
      Y.encodeStateAsUpdate(doc),
      ownerId,
    );
    doc.destroy();

    const body = (await (await getLatest(docId)).json()) as LatestBody;
    expect(body.rev).toBe('1');
    expect(body.is_current).toBe(false);
  });

  // Structural changes are stamped onto docs.updated_at by touchProject,
  // because a max() over doc_files.updated_at cannot see a DELETE — removing a
  // row only ever lowers the maximum. Simulated here at the DB level; the live
  // routes are covered by files.crud / assets.upload.
  it('is_current is false after the project is structurally touched', async () => {
    const docId = await seedDoc();
    await seedCompile(docId, { agoMs: 5_000 });
    expect(((await (await getLatest(docId)).json()) as LatestBody).is_current).toBe(true);

    await fx.db.update(docs).set({ updatedAt: new Date() }).where(eq(docs.id, docId));

    const body = (await (await getLatest(docId)).json()) as LatestBody;
    expect(body.is_current).toBe(false);
  });

  // The delete-safety chain, end to end through the real routes rather than
  // simulated at the DB level. This is the case that motivated touchProject: a
  // max() over doc_files.updated_at cannot see a DELETE, because removing a row
  // only ever lowers the maximum — so without the docs.updated_at stamp the
  // endpoint would report is_current: true and the editor would keep showing a
  // PDF that still contained the deleted chapter.
  it('is_current is false after a real file DELETE through the API', async () => {
    const docId = await seedDoc();

    const created = await fetch(`${fx.baseUrl}/api/docs/${docId}/files`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'chapter2.tex' }),
    });
    expect(created.status).toBe(201);
    const fileId = ((await created.json()) as { file: { id: string } }).file.id;

    // Compile AFTER the file exists, so the project genuinely predates it.
    await seedCompile(docId, { agoMs: 5_000 });
    expect(((await (await getLatest(docId)).json()) as LatestBody).is_current).toBe(true);

    const deleted = await fetch(`${fx.baseUrl}/api/docs/${docId}/files/${fileId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    });
    expect(deleted.status).toBe(204);

    const body = (await (await getLatest(docId)).json()) as LatestBody;
    expect(body.is_current).toBe(false);
  });

  it('is_current is false after a real file CREATE through the API', async () => {
    const docId = await seedDoc();
    await seedCompile(docId, { agoMs: 5_000 });
    expect(((await (await getLatest(docId)).json()) as LatestBody).is_current).toBe(true);

    const created = await fetch(`${fx.baseUrl}/api/docs/${docId}/files`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'appendix.tex' }),
    });
    expect(created.status).toBe(201);

    const body = (await (await getLatest(docId)).json()) as LatestBody;
    expect(body.is_current).toBe(false);
  });

  // A NULL on the right of `>` makes every predicate NULL — "no changes
  // found" — which would read as current. It must not.
  it('is_current is false when the compile row has no finished_at', async () => {
    const docId = await seedDoc();
    await seedCompile(docId, { finishedAt: null });
    const body = (await (await getLatest(docId)).json()) as LatestBody;
    expect(body.is_current).toBe(false);
  });
});
