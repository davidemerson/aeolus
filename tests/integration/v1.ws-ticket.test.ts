import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { auditEvents, db as makeDb, docs, users, wsTickets, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

/**
 * `/api/v1/ws/ticket` — the one route that hands out a credential this plane
 * cannot then police. Once redeemed the caller is on the WebSocket, where there
 * is no scope gate and no rate limit, so the checks that DO apply at mint time
 * are the whole control surface and are pinned here.
 */

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  close(): Promise<void>;
}

let fx: Fixtures;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_test')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();
  await runMigrations(postgres.getConnectionUri());
  const { db, pool } = makeDb({ connectionString: postgres.getConnectionUri() });
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'v1-ws-ticket-test-secret',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
    enableDevRoutes: true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  fx = {
    postgres,
    baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    db,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}, 180_000);

afterAll(async () => {
  await fx?.close();
});

let seq = 0;
async function persona() {
  const email = `v1ws-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email }).returning({ id: users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
  const cookie = `${c.name}=${c.value}`;
  const mint = async (scope: 'read' | 'write') =>
    (
      (await (
        await fetch(`${fx.baseUrl}/api/tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: `${scope}-${seq}`, scope }),
        })
      ).json()) as { token: string }
    ).token;
  const [doc] = await fx.db
    .insert(docs)
    .values({ title: 'collab target', engine: 'latex', ownerId: user.id })
    .returning({ id: docs.id });
  return {
    userId: user.id,
    docId: doc.id,
    cookie,
    read: await mint('read'),
    write: await mint('write'),
  };
}

function mintTicket(token: string, docId: string) {
  return fetch(`${fx.baseUrl}/api/v1/ws/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ doc_id: docId }),
  });
}

describe('POST /api/v1/ws/ticket', () => {
  it('mints a ticket the ws process can redeem, stored only as a hash', async () => {
    const me = await persona();
    const res = await mintTicket(me.write, me.docId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticket: string; doc_id: string; expires_at: string };
    expect(body.doc_id).toBe(me.docId);

    // The plaintext ticket is never stored — the ws server hashes what it is
    // handed and looks the digest up, exactly as the token plane does.
    const digest = createHash('sha256').update(body.ticket).digest('hex');
    const [row] = await fx.db.select().from(wsTickets).where(eq(wsTickets.ticketHash, digest));
    expect(row.userId).toBe(me.userId);
    expect(row.docId).toBe(me.docId);

    // Five minutes, give or take the round trip.
    const ttl = new Date(body.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });

  it('refuses a read-scope token — the socket cannot enforce a scope', async () => {
    const me = await persona();
    const res = await mintTicket(me.read, me.docId);
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({ error: 'read_only_token' });
    // And nothing was written on the way to being refused.
    expect(await fx.db.select().from(wsTickets).where(eq(wsTickets.userId, me.userId))).toEqual([]);
  });

  it("404s another user's document", async () => {
    const me = await persona();
    const other = await persona();
    const res = await mintTicket(me.write, other.docId);
    expect(res.status).toBe(404);
  });

  it('400s a body without a doc_id', async () => {
    const me = await persona();
    const res = await fetch(`${fx.baseUrl}/api/v1/ws/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${me.write}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('audits the mint, naming the plane', async () => {
    const me = await persona();
    await mintTicket(me.write, me.docId);
    const [event] = await fx.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'ws.ticket.mint'), eq(auditEvents.resourceId, me.docId)));
    expect(event.metadata).toMatchObject({ via: 'api_token' });
    expect(event.actorId).toBe(me.userId);
  });

  it('the browser plane still mints, and is not audited as a token', async () => {
    const me = await persona();
    const res = await fetch(`${fx.baseUrl}/api/ws/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: me.cookie },
      body: JSON.stringify({ doc_id: me.docId }),
    });
    expect(res.status).toBe(201);
    const [event] = await fx.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'ws.ticket.mint'), eq(auditEvents.resourceId, me.docId)));
    expect(event.metadata).not.toMatchObject({ via: 'api_token' });
  });
});
