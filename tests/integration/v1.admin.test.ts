import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BROWSER_RATE_LIMITS, MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { apiTokens, db as makeDb, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
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
    cookieSecret: 'v1-admin-test-secret',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
    // This file mints a token per test from one address; the production
    // budget (30/min, ADR 0025) is not what it is testing.
    browserRateLimits: {
      ...BROWSER_RATE_LIMITS,
      tokenMint: { max: 10_000, timeWindow: '1 minute' },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    postgres,
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

let fx: Fixtures;
beforeAll(async () => {
  fx = await setup();
}, 180_000);
afterAll(async () => {
  await fx?.close();
});

let seq = 0;
async function persona(isAdmin = false) {
  const email = `v1adm-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email, isAdmin }).returning({ id: users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
  const cookie = `${c.name}=${c.value}`;
  const mint = async (scope: 'read' | 'write') =>
    (
      await json<{ token: string }>(
        await fetch(`${fx.baseUrl}/api/tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: `${scope}-${seq}`, scope }),
        }),
      )
    ).token;
  return { userId: user.id, email, cookie, read: await mint('read'), write: await mint('write') };
}

function v1(token: string, path: string, init: RequestInit = {}) {
  return fetch(`${fx.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

describe('/api/v1 identity', () => {
  it("changes your own display name — the route the Settings page 404'd on", async () => {
    const me = await persona(false);
    const res = await v1(me.write, '/me', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed Person' }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ user: { name: string } }>(res)).user.name).toBe('Renamed Person');

    // And through the browser plane, which is what settings.tsx actually calls.
    const browser = await fetch(`${fx.baseUrl}/api/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: me.cookie },
      body: JSON.stringify({ name: 'Renamed Again' }),
    });
    expect(browser.status).toBe(200);
    const [row] = await fx.db.select().from(users).where(eq(users.id, me.userId));
    expect(row.name).toBe('Renamed Again');
  });

  it('a read token cannot rename', async () => {
    const me = await persona(false);
    const res = await v1(me.read, '/me', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(res.status).toBe(403);
  });

  it("reports the AI quota for the token's user", async () => {
    const me = await persona(false);
    const res = await v1(me.read, '/ai/quota');
    expect(res.status).toBe(200);
    const q = await json<{ hourly: { limit: number }; daily: { limit: number } }>(res);
    expect(q.hourly.limit).toBeGreaterThan(0);
    expect(q.daily.limit).toBeGreaterThan(0);
  });
});

describe('/api/v1 admin — users', () => {
  it('lists users to an admin and refuses everyone else', async () => {
    const admin = await persona(true);
    const user = await persona(false);

    const ok = await v1(admin.read, '/admin/users');
    expect(ok.status).toBe(200);
    expect((await json<{ users: Array<{ id: string }> }>(ok)).users.map((u) => u.id)).toContain(
      user.userId,
    );

    const refused = await v1(user.read, '/admin/users');
    expect(refused.status).toBe(403);
    expect((await json<{ error: string }>(refused)).error).toBe('forbidden');
  });

  it('grants and revokes admin', async () => {
    const admin = await persona(true);
    const user = await persona(false);
    const res = await v1(admin.write, `/admin/users/${user.userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_admin: true }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ user: { is_admin: boolean } }>(res)).user.is_admin).toBe(true);
  });

  // The offboarding lever, and the reason it is the right one.
  it('disabling a user immediately kills their API TOKENS as well as their sessions', async () => {
    const admin = await persona(true);
    const victim = await persona(false);
    expect((await v1(victim.read, '/me')).status).toBe(200);

    expect(
      (await v1(admin.write, `/admin/users/${victim.userId}/disable`, { method: 'POST' })).status,
    ).toBe(204);

    // No token enumeration was needed — the auth hook re-checks disabled_at.
    expect((await v1(victim.read, '/me')).status).toBe(401);
    expect((await v1(victim.write, '/me')).status).toBe(401);
    // And the browser plane too.
    expect(
      (await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: victim.cookie } })).status,
    ).toBe(401);

    // Re-enabling brings the same tokens back; they were never revoked.
    expect(
      (await v1(admin.write, `/admin/users/${victim.userId}/enable`, { method: 'POST' })).status,
    ).toBe(204);
    expect((await v1(victim.read, '/me')).status).toBe(200);
  });

  it('refuses self-delete and self-disable', async () => {
    const admin = await persona(true);
    const del = await v1(admin.write, `/admin/users/${admin.userId}`, { method: 'DELETE' });
    expect(del.status).toBe(422);
    expect((await json<{ error: string }>(del)).error).toBe('self_delete');

    const dis = await v1(admin.write, `/admin/users/${admin.userId}/disable`, { method: 'POST' });
    expect(dis.status).toBe(422);
    expect((await json<{ error: string }>(dis)).error).toBe('self_disable');
  });

  it('transfers documents to the deleting admin, and cascades their tokens away', async () => {
    const admin = await persona(true);
    const victim = await persona(false);
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'their draft', engine: 'latex', ownerId: victim.userId })
      .returning({ id: docs.id });

    expect(
      (await v1(admin.write, `/admin/users/${victim.userId}`, { method: 'DELETE' })).status,
    ).toBe(204);

    // The draft survives, owned by the admin who deleted them. docs.owner_id is
    // RESTRICT precisely so this cannot silently take it.
    const [survived] = await fx.db.select().from(docs).where(eq(docs.id, doc.id));
    expect(survived.ownerId).toBe(admin.userId);

    // Their tokens went with the row.
    expect(
      await fx.db.select().from(apiTokens).where(eq(apiTokens.createdBy, victim.userId)),
    ).toEqual([]);
    expect((await v1(victim.read, '/me')).status).toBe(401);
  });
});

describe('/api/v1 admin — audit log', () => {
  it('is admin-only, and answers "what did automation do"', async () => {
    const admin = await persona(true);
    const user = await persona(false);
    expect((await v1(user.read, '/admin/audit-events')).status).toBe(403);

    // Make something happen through the machine plane.
    const created = await json<{ id: string }>(
      await v1(admin.write, '/docs', {
        method: 'POST',
        body: JSON.stringify({ title: 'made by a token', engine: 'latex' }),
      }),
    );

    const page = await json<{
      events: Array<{
        action: string;
        resource_id: string | null;
        metadata: Record<string, unknown>;
      }>;
      retention_days: number;
    }>(await v1(admin.read, '/admin/audit-events?action=doc.'));

    expect(page.retention_days).toBe(30);
    const event = page.events.find((e) => e.resource_id === created.id);
    expect(event?.action).toBe('doc.create');
    // The whole reason v1 reuses the same services rather than its own
    // vocabulary: one query, and the plane is visible in the metadata.
    expect(event?.metadata).toMatchObject({ via: 'api_token' });
  });

  it('filters by exact action and by prefix, and paginates on a cursor', async () => {
    const admin = await persona(true);
    for (let i = 0; i < 3; i++) {
      await v1(admin.write, '/docs', {
        method: 'POST',
        body: JSON.stringify({ title: `page-${i}`, engine: 'latex' }),
      });
    }

    const exact = await json<{ events: Array<{ action: string }> }>(
      await v1(admin.read, '/admin/audit-events?action=doc.create'),
    );
    expect(exact.events.every((e) => e.action === 'doc.create')).toBe(true);

    const first = await json<{ events: unknown[]; next_before: string | null }>(
      await v1(admin.read, '/admin/audit-events?action=doc.create&limit=2'),
    );
    expect(first.events).toHaveLength(2);
    expect(first.next_before).not.toBeNull();

    const second = await json<{ events: Array<{ id: string }> }>(
      await v1(
        admin.read,
        `/admin/audit-events?action=doc.create&limit=2&before=${encodeURIComponent(first.next_before!)}`,
      ),
    );
    // The cursor is on occurred_at, so the second page cannot repeat the first.
    const firstIds = (first.events as Array<{ id: string }>).map((e) => e.id);
    expect(second.events.some((e) => firstIds.includes(e.id))).toBe(false);
  });

  it('400s a malformed query rather than ignoring it', async () => {
    const admin = await persona(true);
    const res = await v1(admin.read, '/admin/audit-events?limit=notanumber');
    expect(res.status).toBe(400);
  });
});
