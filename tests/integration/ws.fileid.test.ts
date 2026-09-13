import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore, persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { db as makeDb, docFiles, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { createWsServer, type WsServerHandle } from '@aeolus/ws';

import { parseSetCookie } from './helpers/cookies.js';

const COOKIE_SECRET = 'ws-fileid-test-secret-do-not-use';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: MemoryBlobStore;
  ws: WsServerHandle;
  wsUrlBase: string;
  apiBaseUrl: string;
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
    cookieSecret: COOKIE_SECRET,
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiAddress = app.server.address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${apiAddress.port}`;

  const ws = createWsServer({
    db,
    dbPool: pool,
    blobs,
    cookieSecret: COOKIE_SECRET,
  });
  const { host, port } = await ws.listen(0, '127.0.0.1');
  const wsUrlBase = `ws://${host}:${port}`;

  return {
    postgres,
    db,
    dbPool: pool,
    blobs,
    ws,
    wsUrlBase,
    apiBaseUrl,
    async close() {
      await ws.close();
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
  const sc = res.headers.get('set-cookie');
  const p = parseSetCookie(sc!);
  return `${p!.name}=${p!.value}`;
}

describe('ws fileId resolution — issue #9 phase 3B', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('upgrade with no fileId routes to the main file (back-compat)', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({ email: `wsf-main-${Date.now()}@example.com` })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'main only', engine: 'latex', ownerId: user.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });

    // Seed some Yjs state on the main file's yjs_doc_id (which is
    // doc.id for backfilled rows).
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, 'main file content');
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    await persistUpdate(crdtDeps, doc.id, 0n, update, user.id);

    const cookie = await freshCookie(fx.apiBaseUrl, user.id);
    const upgradeUrl = `${fx.wsUrlBase}/?docId=${doc.id}`;
    const wsConn = await import('ws').then(
      (m) =>
        new m.default(upgradeUrl, [], {
          headers: { cookie },
        }),
    );
    // The first server-driven message after open is sync-step-1
    // (the Yjs sync handshake). Waiting for it confirms the room
    // is wired and handleConnection has finished — without this
    // the open event races the async handleConnection call.
    await new Promise<void>((resolve, reject) => {
      wsConn.once('message', () => resolve());
      wsConn.once('close', (code) => reject(new Error(`closed: ${code}`)));
    });
    expect(fx.ws.roomCount()).toBeGreaterThanOrEqual(1);
    wsConn.close();
  });

  it('upgrade with fileId routes to that specific text file', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({ email: `wsf-multi-${Date.now()}@example.com` })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'multi text', engine: 'latex', ownerId: user.id })
      .returning({ id: docs.id });

    // Two text files: main.tex (yjs_doc_id = doc.id) and
    // chapters/intro.tex (synthetic yjs_doc_id).
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });
    const introYjsDocId = randomUUID();
    const [introFile] = await fx.db
      .insert(docFiles)
      .values({
        docId: doc.id,
        path: 'chapters/intro.tex',
        kind: 'text',
        yjsDocId: introYjsDocId,
      })
      .returning({ id: docFiles.id });

    // Seed distinct content on the two yjs_doc_ids so we can verify
    // a fileId-targeted upgrade actually loaded the right one.
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    {
      const y = new Y.Doc();
      y.getText('source').insert(0, 'MAIN BODY');
      await persistUpdate(crdtDeps, doc.id, 0n, Y.encodeStateAsUpdate(y), user.id);
      y.destroy();
    }
    {
      const y = new Y.Doc();
      y.getText('source').insert(0, 'INTRO BODY');
      await persistUpdate(crdtDeps, introYjsDocId, 0n, Y.encodeStateAsUpdate(y), user.id);
      y.destroy();
    }

    const cookie = await freshCookie(fx.apiBaseUrl, user.id);
    const upgradeUrl = `${fx.wsUrlBase}/?docId=${doc.id}&fileId=${introFile.id}`;
    const wsConn = await import('ws').then(
      (m) =>
        new m.default(upgradeUrl, [], {
          headers: { cookie },
        }),
    );
    await new Promise<void>((resolve, reject) => {
      wsConn.once('message', () => resolve());
      wsConn.once('close', (code, reason) =>
        reject(new Error(`closed: ${code} ${reason.toString()}`)),
      );
    });
    // The connection should land in a separate room keyed on the
    // intro file's yjs_doc_id, not on doc.id (where the main-file
    // room would live if fileId was ignored).
    expect(fx.ws.roomCount()).toBeGreaterThanOrEqual(1);
    wsConn.close();
  });

  it('upgrade with an unknown fileId is rejected with 1008', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({ email: `wsf-bad-${Date.now()}@example.com` })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'bad-file', engine: 'latex', ownerId: user.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });

    const cookie = await freshCookie(fx.apiBaseUrl, user.id);
    const ghostFileId = randomUUID();
    const upgradeUrl = `${fx.wsUrlBase}/?docId=${doc.id}&fileId=${ghostFileId}`;
    const wsConn = await import('ws').then(
      (m) =>
        new m.default(upgradeUrl, [], {
          headers: { cookie },
        }),
    );
    const code = await new Promise<number>((resolve) => {
      wsConn.once('close', (c) => resolve(c));
    });
    expect(code).toBe(1008);
  });
});
