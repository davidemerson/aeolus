import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { MemoryBlobStore, persistUpdate } from '@aeolus/crdt';
import { db as makeDb, users, type Database } from '@aeolus/db';
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
    cookieSecret: 'project-zip-test-secret',
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

interface Session {
  userId: string;
  cookie: string;
  docId: string;
}

async function freshUserAndDoc(fx: Fixtures, title = 'My Project'): Promise<Session> {
  // Admin so POST /docs below passes the issue-#39 gate.
  const u = await fx.db
    .insert(users)
    .values({
      email: `zip-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
      isAdmin: true,
    })
    .returning({ id: users.id });
  const userId = u[0].id;
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const sc = sess.headers.get('set-cookie');
  const p = parseSetCookie(sc!);
  const cookie = `${p!.name}=${p!.value}`;
  const create = await fetch(`${fx.baseUrl}/api/docs`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title, engine: 'latex' }),
  });
  const { id: docId } = (await create.json()) as { id: string };
  return { userId, cookie, docId };
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

describe('GET /docs/:id/download.zip', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('streams every text and blob file in the project', async () => {
    const s = await freshUserAndDoc(fx, 'Hello World');

    // Stage source for main.tex (yjs_doc_id == docs.id for the
    // auto-created main entrypoint).
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, '\\documentclass{article}\nMain.\n');
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    await persistUpdate({ db: fx.db, blobs: fx.blobs }, s.docId, 0n, update, s.userId);

    // Add a second text file via the existing /files API.
    const create = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'chapters/intro.tex' }),
    });
    expect(create.status).toBe(201);
    const { file: introFile } = (await create.json()) as {
      file: { yjs_doc_id: string };
    };
    const intro = new Y.Doc();
    intro.getText('source').insert(0, 'Intro chapter.\n');
    const introUpdate = Y.encodeStateAsUpdate(intro);
    intro.destroy();
    await persistUpdate(
      { db: fx.db, blobs: fx.blobs },
      introFile.yjs_doc_id,
      0n,
      introUpdate,
      s.userId,
    );

    // Add a binary file at a sub-folder path.
    const fd = new FormData();
    fd.append('path', 'images/logo.png');
    fd.append('file', new File([new Uint8Array(PNG_1X1)], 'logo.png', { type: 'image/png' }));
    const upload = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/upload`, {
      method: 'POST',
      headers: { cookie: s.cookie },
      body: fd,
    });
    expect(upload.status).toBe(201);

    // Download the zip and verify against system unzip.
    const res = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/download.zip`, {
      headers: { cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(
      'attachment; filename="Hello-World.zip"',
    );
    const archive = Buffer.from(await res.arrayBuffer());
    expect(archive.length).toBeGreaterThan(0);

    const dir = mkdtempSync(path.join(tmpdir(), 'pz-'));
    try {
      const zipPath = path.join(dir, 'p.zip');
      writeFileSync(zipPath, archive);
      const out = path.join(dir, 'out');
      const r = spawnSync('unzip', ['-q', zipPath, '-d', out]);
      expect(r.status).toBe(0);
      expect(readdirSync(out).sort()).toEqual(['chapters', 'images', 'main.tex']);
      expect(readFileSync(path.join(out, 'main.tex'), 'utf8')).toBe(
        '\\documentclass{article}\nMain.\n',
      );
      expect(readFileSync(path.join(out, 'chapters/intro.tex'), 'utf8')).toBe('Intro chapter.\n');
      expect(readFileSync(path.join(out, 'images/logo.png'))).toEqual(PNG_1X1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 404 for a non-collaborator', async () => {
    const owner = await freshUserAndDoc(fx);
    // Second user with no access to owner's doc.
    const u = await fx.db
      .insert(users)
      .values({
        email: `zip-other-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
      })
      .returning({ id: users.id });
    const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: u[0].id }),
    });
    const sc = sess.headers.get('set-cookie');
    const p = parseSetCookie(sc!);
    const cookie = `${p!.name}=${p!.value}`;

    const res = await fetch(`${fx.baseUrl}/api/docs/${owner.docId}/download.zip`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const s = await freshUserAndDoc(fx);
    const res = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/download.zip`);
    expect(res.status).toBe(401);
  });
});
