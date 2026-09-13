import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import WebSocket from 'ws';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, docFiles, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { createWsServer, type WsServerHandle } from '@aeolus/ws';

import { parseSetCookie } from './helpers/cookies.js';
import { waitFor } from './helpers/poll.js';

const APP_ORIGIN = 'http://app.test';
const COOKIE_SECRET = 'ws-ticket-test-secret-do-not-use';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: MemoryBlobStore;
  ws: WsServerHandle;
  wsUrlBase: string;
  apiBaseUrl: string;
  // Structured [ws] log lines captured via the injectable log dep.
  logLines: string[];
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

  const logLines: string[] = [];
  const ws = createWsServer({
    db,
    dbPool: pool,
    blobs,
    cookieSecret: COOKIE_SECRET,
    allowedOrigins: [APP_ORIGIN],
    log: (line) => {
      logLines.push(line);
    },
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
    logLines,
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
  if (res.status !== 201) throw new Error(`dev session ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

async function mintTicket(
  baseUrl: string,
  cookie: string,
  docId: string,
): Promise<{ ticket: string; status: number; error?: string }> {
  const res = await fetch(`${baseUrl}/api/ws/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ doc_id: docId }),
  });
  const body = (await res.json()) as { ticket?: string; error?: string };
  return { status: res.status, ticket: body.ticket ?? '', error: body.error };
}

async function expectClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    ws.once('close', (code, reason) =>
      resolve({ code, reason: Buffer.from(reason).toString('utf8') }),
    );
    ws.once('error', () => {
      /* close fires anyway */
    });
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

describe('ws ticket auth', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  async function makeUserAndDoc(
    isAdmin = false,
  ): Promise<{ userId: string; cookie: string; docId: string }> {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [u] = await fx.db
      .insert(users)
      .values({ email: `wt-${suffix}@example.com`, isAdmin })
      .returning({ id: users.id });
    const [d] = await fx.db
      .insert(docs)
      .values({ title: `wt-doc-${suffix}`, engine: 'latex', ownerId: u.id })
      .returning({ id: docs.id });
    // Phase-3 dual-write so the ws upgrade can resolve docId →
    // main file's yjs_doc_id.
    await fx.db.insert(docFiles).values({
      docId: d.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: d.id,
    });
    const cookie = await freshCookie(fx.apiBaseUrl, u.id);
    return { userId: u.id, cookie, docId: d.id };
  }

  it('refuses a cookie upgrade from another origin with 1008 bad_origin', async () => {
    const { cookie, docId } = await makeUserAndDoc();
    const { connectYjsClient } = await import('./helpers/yjs-client.js');
    const client = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie, {
      origin: 'https://evil.example',
    });
    expect(await expectClose(client.socket)).toEqual({ code: 1008, reason: 'bad_origin' });
    expect(fx.logLines.some((l) => l.includes('upgrade_rejected reason=bad_origin'))).toBe(true);
  });

  it("accepts a cookie upgrade from the app's own origin", async () => {
    const { cookie, docId } = await makeUserAndDoc();
    const { connectYjsClient } = await import('./helpers/yjs-client.js');
    const client = connectYjsClient(`${fx.wsUrlBase}/?docId=${docId}`, cookie, {
      origin: APP_ORIGIN,
    });
    await client.waitOpen();
    await client.close();
  });

  it('/readyz reports the database and the LISTEN client', async () => {
    const res = await fetch(fx.wsUrlBase.replace(/^ws/, 'http') + '/readyz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: { db: boolean; listen: boolean } };
    expect(body).toEqual({ ok: true, checks: { db: true, listen: true } });
  });

  it('mints a ticket and uses it on the upgrade', async () => {
    const { cookie, docId } = await makeUserAndDoc();
    const t = await mintTicket(fx.apiBaseUrl, cookie, docId);
    expect(t.status).toBe(201);
    expect(t.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const upgradeUrl = `${fx.wsUrlBase}/?docId=${docId}&ticket=${encodeURIComponent(t.ticket)}`;
    const ws = new WebSocket(upgradeUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 5000);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts a renewed reconnect within the TTL window', async () => {
    // Tickets are multi-use within TTL so y-websocket's auto-
    // reconnect (which reuses the same upgrade URL) doesn't trip a
    // permanent policy failure on a single network blip. Single-use
    // was the original design but produced a guaranteed banner on
    // any reconnect — see consumeTicket in apps/ws/src/server.ts.
    const { cookie, docId } = await makeUserAndDoc();
    const t = await mintTicket(fx.apiBaseUrl, cookie, docId);
    expect(t.status).toBe(201);

    const url = `${fx.wsUrlBase}/?docId=${docId}&ticket=${encodeURIComponent(t.ticket)}`;
    // First use opens.
    const ws1 = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws1.once('open', () => resolve());
      ws1.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 5000);
    });
    ws1.close();

    // Second use: same ticket, still within the window — should
    // open cleanly (the y-websocket reconnect path).
    const ws2 = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws2.once('open', () => resolve());
      ws2.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 5000);
    });
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    ws2.close();
  });

  it('rejects a ticket past its TTL', async () => {
    // Force-expire by writing an expires_at in the past directly to
    // the row; this avoids a 5-minute real wait while still
    // exercising the TTL gate.
    const { cookie, docId } = await makeUserAndDoc();
    const t = await mintTicket(fx.apiBaseUrl, cookie, docId);
    expect(t.status).toBe(201);

    const { wsTickets } = await import('@aeolus/db');
    const { sql } = await import('drizzle-orm');
    await fx.db.update(wsTickets).set({ expiresAt: sql`now() - interval '1 minute'` });

    const url = `${fx.wsUrlBase}/?docId=${docId}&ticket=${encodeURIComponent(t.ticket)}`;
    const ws = new WebSocket(url);
    const closed = await expectClose(ws);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('invalid_ticket');
  });

  it('rejects a ticket bound to a different doc', async () => {
    const a = await makeUserAndDoc();
    const b = await makeUserAndDoc();
    const t = await mintTicket(fx.apiBaseUrl, a.cookie, a.docId);
    expect(t.status).toBe(201);

    const url = `${fx.wsUrlBase}/?docId=${b.docId}&ticket=${encodeURIComponent(t.ticket)}`;
    const ws = new WebSocket(url);
    const closed = await expectClose(ws);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('ticket_doc_mismatch');
  });

  it('rejects an invalid ticket', async () => {
    const { docId } = await makeUserAndDoc();
    const url = `${fx.wsUrlBase}/?docId=${docId}&ticket=garbage-not-a-real-ticket`;
    const ws = new WebSocket(url);
    const closed = await expectClose(ws);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('invalid_ticket');
  });

  it('cookie path still works (no ticket)', async () => {
    const { cookie, docId } = await makeUserAndDoc();
    const url = `${fx.wsUrlBase}/?docId=${docId}`;
    const ws = new WebSocket(url, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 5000);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('mint requires authentication', async () => {
    const { docId } = await makeUserAndDoc();
    const res = await fetch(`${fx.apiBaseUrl}/api/ws/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_id: docId }),
    });
    expect(res.status).toBe(401);
  });

  it('mint refuses for users without read access', async () => {
    const owner = await makeUserAndDoc();
    const outsider = await makeUserAndDoc();
    const t = await mintTicket(fx.apiBaseUrl, outsider.cookie, owner.docId);
    expect(t.status).toBe(404);
  });

  it("echoes the sender's awareness back (solo keepalive)", async () => {
    // The awareness relay deliberately includes the origin
    // connection: y-websocket's client closes any socket that stays
    // silent for messageReconnectTimeout (30s), and a solo editor
    // otherwise receives nothing after the handshake — the echo of
    // its own ~15s awareness renewals is what keeps the socket
    // alive. Assert the echo directly instead of waiting 30s.
    const { cookie, docId } = await makeUserAndDoc();
    const t = await mintTicket(fx.apiBaseUrl, cookie, docId);
    expect(t.status).toBe(201);

    const url = `${fx.wsUrlBase}/?docId=${docId}&ticket=${encodeURIComponent(t.ticket)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 5000);
    });

    // Build the awareness frame exactly like the browser client does.
    const localDoc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(localDoc);
    awareness.setLocalState({ user: { name: 'echo-test' } });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // messageAwareness
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [localDoc.clientID]),
    );

    const echoed = new Promise<boolean>((resolve, reject) => {
      const receiver = new awarenessProtocol.Awareness(new Y.Doc());
      ws.on('message', (data) => {
        const buf =
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
        const decoder = decoding.createDecoder(buf);
        if (decoding.readVarUint(decoder) !== 1) return; // skip sync frames
        awarenessProtocol.applyAwarenessUpdate(receiver, decoding.readVarUint8Array(decoder), null);
        if (receiver.getStates().has(localDoc.clientID)) resolve(true);
      });
      setTimeout(() => reject(new Error('no awareness echo within 3s')), 3000);
    });

    ws.send(encoding.toUint8Array(encoder));
    await expect(echoed).resolves.toBe(true);
    ws.close();
  });

  it('logs structured lines for rejected and accepted upgrades', async () => {
    const { cookie, docId } = await makeUserAndDoc();

    const before = fx.logLines.length;
    const badUrl = `${fx.wsUrlBase}/?docId=${docId}&ticket=garbage-for-log-test`;
    const wsBad = new WebSocket(badUrl);
    const closed = await expectClose(wsBad);
    expect(closed.code).toBe(1008);
    const rejected = fx.logLines.slice(before).find((l) => l.includes('upgrade_rejected'));
    expect(rejected).toBeDefined();
    expect(rejected).toContain('reason=invalid_ticket');
    expect(rejected).toContain(`docId=${docId}`);

    const t = await mintTicket(fx.apiBaseUrl, cookie, docId);
    const goodUrl = `${fx.wsUrlBase}/?docId=${docId}&ticket=${encodeURIComponent(t.ticket)}`;
    const wsGood = new WebSocket(goodUrl);
    await new Promise<void>((resolve, reject) => {
      wsGood.once('open', () => resolve());
      wsGood.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 5000);
    });
    // The accepted line is written just before handleConnection runs;
    // poll for it rather than sleeping (#77).
    const accepted = await waitFor(
      () =>
        fx.logLines
          .slice(before)
          .find((l) => l.includes('upgrade_accepted') && l.includes(`docId=${docId}`)),
      { label: 'upgrade_accepted log line' },
    );
    expect(accepted).toBeDefined();
    wsGood.close();
  });
});
