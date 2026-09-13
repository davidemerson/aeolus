import cookieSigner from '@fastify/cookie';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createSessionStore, sessionConstants } from '@aeolus/auth';
import { MemoryBlobStore } from '@aeolus/crdt';
import {
  db as makeDb,
  docCollaborators,
  docFiles,
  docSnapshots,
  docUpdates,
  docs,
  users,
  type Database,
} from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { createWsServer, type WsServerHandle } from '@aeolus/ws';
import { eq } from 'drizzle-orm';

import { waitFor, waitForSettled } from './helpers/poll.js';

const COOKIE_SECRET = 'integration-test-secret-do-not-use';

// A MemoryBlobStore whose reads can be made slow on demand. The ws server
// reads the snapshot blob while loading a room; stretching that read
// widens the window between "upgrade accepted" and "room ready" so the
// connect-window test below can land a frame inside it deterministically.
class LaggyBlobStore extends MemoryBlobStore {
  getDelayMs = 0;

  override async get(key: string): Promise<Buffer | null> {
    if (this.getDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.getDelayMs));
    }
    return super.get(key);
  }
}

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: LaggyBlobStore;
  ws: WsServerHandle;
  wsUrlBase: string;
  signer: ReturnType<typeof cookieSigner.signerFactory>;
  // Structured ws log lines, newest last. Tests that need to act at a
  // precise point in the upgrade sequence register a listener here.
  logListeners: Set<(line: string) => void>;
  close(): Promise<void>;
  restartWs(): Promise<void>;
}

async function setup(): Promise<Fixtures> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_test')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();
  const connectionString = postgres.getConnectionUri();
  await runMigrations(connectionString);
  const { db, pool } = makeDb({ connectionString });
  const blobs = new LaggyBlobStore();
  const signer = cookieSigner.signerFactory(COOKIE_SECRET);
  const logListeners = new Set<(line: string) => void>();

  const startServer = async (): Promise<{ ws: WsServerHandle; url: string }> => {
    const ws = createWsServer({
      db,
      dbPool: pool,
      blobs,
      cookieSecret: COOKIE_SECRET,
      snapshotUpdateThreshold: 4,
      snapshotIdleMs: 60_000,
      log: (line) => {
        for (const listener of logListeners) listener(line);
      },
    });
    const { port, host } = await ws.listen(0, '127.0.0.1');
    return { ws, url: `ws://${host}:${port}` };
  };

  let { ws, url } = await startServer();

  const fixtures: Fixtures = {
    postgres,
    db,
    dbPool: pool,
    blobs,
    ws,
    wsUrlBase: url,
    signer,
    logListeners,
    async close() {
      await ws.close();
      await pool.end();
      await postgres.stop();
    },
    async restartWs() {
      await ws.close();
      const restarted = await startServer();
      fixtures.ws = restarted.ws;
      fixtures.wsUrlBase = restarted.url;
      ws = restarted.ws;
      url = restarted.url;
    },
  };

  return fixtures;
}

async function seedUserAndDoc(fx: Fixtures): Promise<{
  ownerId: string;
  outsiderId: string;
  docId: string;
}> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const [owner] = await fx.db
    .insert(users)
    .values({ email: `owner-${suffix}@example.com`, name: 'Owner', isAdmin: false })
    .returning({ id: users.id });
  const [outsider] = await fx.db
    .insert(users)
    .values({ email: `outsider-${suffix}@example.com`, name: 'Outsider', isAdmin: false })
    .returning({ id: users.id });
  const [doc] = await fx.db
    .insert(docs)
    .values({ title: `Doc ${suffix}`, engine: 'latex', ownerId: owner.id })
    .returning({ id: docs.id });
  // Phase 3 of issue #9 retargets doc_updates.yjs_doc_id → doc_files.
  // Tests that bypass the API have to mirror the API's dual-write so
  // the FK target exists.
  await fx.db.insert(docFiles).values({
    docId: doc.id,
    path: 'main.tex',
    kind: 'text',
    yjsDocId: doc.id,
  });
  return { ownerId: owner.id, outsiderId: outsider.id, docId: doc.id };
}

async function sessionCookieFor(fx: Fixtures, userId: string): Promise<string> {
  const store = createSessionStore(fx.db);
  const { token } = await store.create(userId);
  const signed = fx.signer.sign(token);
  return `${sessionConstants.COOKIE_NAME}=${encodeURIComponent(signed)}`;
}

describe('yjs websocket', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('two clients converge on the same text', async () => {
    const { ownerId, docId } = await seedUserAndDoc(fx);
    const cookie = await sessionCookieFor(fx, ownerId);

    const { connectYjsClient } = await import('./helpers/yjs-client.js');
    const client1 = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie);
    const client2 = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie);
    await client1.waitOpen();
    await client2.waitOpen();

    client1.doc.getText('source').insert(0, 'Hello ');
    await new Promise((r) => setTimeout(r, 50));
    client2.doc.getText('source').insert(client2.doc.getText('source').length, 'world!');

    const text1 = await client1.waitForText((t) => t === 'Hello world!');
    const text2 = await client2.waitForText((t) => t === 'Hello world!');
    expect(text1).toBe('Hello world!');
    expect(text2).toBe('Hello world!');

    await client1.close();
    await client2.close();
  });

  it('persists state across ws server restart', async () => {
    const { ownerId, docId } = await seedUserAndDoc(fx);
    const cookie = await sessionCookieFor(fx, ownerId);
    const { connectYjsClient } = await import('./helpers/yjs-client.js');

    const writer = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie);
    await writer.waitOpen();
    writer.doc.getText('source').insert(0, 'durable');
    // Persist is fire-and-forget on the ws side (#77): wait for the
    // row rather than guessing how long the runner's DB takes.
    const persisted = await waitFor(
      async () => {
        const rows = await fx.dbPool.query<{ count: string }>(
          'SELECT count(*)::text as count FROM doc_updates WHERE yjs_doc_id = $1',
          [docId],
        );
        return Number(rows.rows[0]?.count ?? '0');
      },
      { label: 'doc_updates persisted' },
    );
    await writer.close();
    expect(persisted).toBeGreaterThan(0);

    await fx.restartWs();

    const reader = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie);
    await reader.waitOpen();
    const text = await reader.waitForText((t) => t === 'durable');
    expect(text).toBe('durable');
    await reader.close();
  });

  it('rejects unauthorized users with 1008', async () => {
    const { outsiderId, docId } = await seedUserAndDoc(fx);
    const cookie = await sessionCookieFor(fx, outsiderId);

    const socket = new WebSocket(`${fx.wsUrlBase}/?docId=${docId}`, {
      headers: { cookie },
    });
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once('close', (code) => resolve(code));
      socket.once('error', (err) => reject(err));
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    expect(closeCode).toBe(1008);
  });

  it('rejects missing cookie with 1008', async () => {
    const { docId } = await seedUserAndDoc(fx);
    const socket = new WebSocket(`${fx.wsUrlBase}/?docId=${docId}`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once('close', (code) => resolve(code));
      socket.once('error', (err) => reject(err));
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    expect(closeCode).toBe(1008);
  });

  it('a frame that arrives while the room is still loading is not dropped', async () => {
    // Regression for the connect window: the upgrade handler used to
    // detach its early-message buffer BEFORE handleConnection awaited
    // getOrCreateRoom (a DB round-trip plus the snapshot S3 GET) and only
    // attached the real listener afterwards. A client that sent sync
    // step 1 in that window — y-websocket sends it the instant the
    // socket opens — never got the server's step 2 and showed an empty
    // document until the next reconnect.
    const { ownerId, docId } = await seedUserAndDoc(fx);
    const cookie = await sessionCookieFor(fx, ownerId);
    const { connectYjsClient } = await import('./helpers/yjs-client.js');

    // Seed content and force it into a snapshot so the room load has a
    // blob to read.
    const writer = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie);
    await writer.waitOpen();
    writer.doc.getText('source').insert(0, 'seed text');
    await waitForSettled(
      async () => {
        const rows = await fx.db
          .select({ id: docUpdates.id })
          .from(docUpdates)
          .where(eq(docUpdates.yjsDocId, docId));
        return rows.length > 0 ? rows.map((r) => r.id) : null;
      },
      { label: 'seed update persisted' },
    );
    expect(await fx.ws.forceSnapshot(docId)).not.toBeNull();
    await writer.close();

    // Evict the room the way the api does after a checkpoint restore, so
    // the next connection has to load it from scratch. Rooms from earlier
    // tests in this file are still cached (60 s idle), so wait for the
    // count to drop rather than reach zero.
    const roomsBefore = fx.ws.roomCount();
    await fx.dbPool.query("SELECT pg_notify('aeolus_room_evict', $1)", [docId]);
    await waitFor(async () => (fx.ws.roomCount() < roomsBefore ? true : null), {
      label: 'room evicted',
    });

    // Make the snapshot read slow, and fire step 1 the moment the server
    // logs upgrade_accepted — that line is written synchronously after the
    // auth phase and before the room load begins, so the frame arrives
    // while the room is still loading.
    fx.blobs.getDelayMs = 300;
    const reader = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie, {
      sendSyncStep1OnOpen: false,
    });
    const onLog = (line: string): void => {
      if (line.includes('upgrade_accepted') && line.includes(`docId=${docId}`)) {
        reader.sendSyncStep1();
      }
    };
    fx.logListeners.add(onLog);
    try {
      const text = await reader.waitForText((t) => t === 'seed text', 5_000);
      expect(text).toBe('seed text');
    } finally {
      fx.logListeners.delete(onLog);
      fx.blobs.getDelayMs = 0;
      await reader.close();
    }
  });

  it('snapshot compaction deletes old update rows', async () => {
    const { ownerId, docId } = await seedUserAndDoc(fx);
    const cookie = await sessionCookieFor(fx, ownerId);
    const { connectYjsClient } = await import('./helpers/yjs-client.js');

    const client = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie);
    await client.waitOpen();

    const text = client.doc.getText('source');
    for (let i = 0; i < 6; i++) {
      text.insert(text.length, `chunk${i}-`);
      await new Promise((r) => setTimeout(r, 20));
    }
    // Same fire-and-forget persist (#77): wait for the update rows to
    // land AND stop trickling in, instead of sleeping a fixed 200ms
    // that is 7.5x stricter than the worker's own tolerance for this
    // lag. Reading `before` while writes were still arriving is what
    // made the exact-count assertion below flaky.
    const before = await waitForSettled(
      async () => {
        const rows = await fx.db.select().from(docUpdates).where(eq(docUpdates.yjsDocId, docId));
        return rows.length > 0 ? rows.map((r) => r.id) : null;
      },
      { label: 'doc_updates rows before compaction' },
    );
    expect(before.length).toBeGreaterThan(0);

    const result = await fx.ws.forceSnapshot(docId);
    expect(result).not.toBeNull();
    // Compaction deletes every update row that existed — at least the
    // ones we observed; `after` below proves none survived.
    expect(Number(result!.deletedRows)).toBeGreaterThanOrEqual(before.length);

    const after = await fx.db.select().from(docUpdates).where(eq(docUpdates.yjsDocId, docId));
    expect(after.length).toBe(0);

    const snapRows = await fx.db
      .select()
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, docId));
    expect(snapRows.length).toBe(1);

    await client.close();
  });

  it('a collaborator can sync even when the owner is offline', async () => {
    const { ownerId, docId } = await seedUserAndDoc(fx);
    const [collab] = await fx.db
      .insert(users)
      .values({
        email: `collab-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.com`,
        name: 'Collab',
        isAdmin: false,
      })
      .returning({ id: users.id });
    await fx.db.insert(docCollaborators).values({ docId, userId: collab.id, role: 'editor' });

    const ownerCookie = await sessionCookieFor(fx, ownerId);
    const collabCookie = await sessionCookieFor(fx, collab.id);
    const { connectYjsClient } = await import('./helpers/yjs-client.js');

    const ownerClient = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, ownerCookie);
    const collabClient = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, collabCookie);
    await ownerClient.waitOpen();
    await collabClient.waitOpen();

    collabClient.doc.getText('source').insert(0, 'from-collab');
    const received = await ownerClient.waitForText((t) => t === 'from-collab');
    expect(received).toBe('from-collab');

    await ownerClient.close();
    await collabClient.close();
  });
});
