import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { eq } from 'drizzle-orm';

import { parseSetCookie } from './helpers/cookies.js';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  mail: MemoryMailAdapter;
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
  const mail = new MemoryMailAdapter();
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'admin-users-test-secret',
    mail,
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
    mail,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function devCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev sessions ${res.status}`);
  const sc = res.headers.get('set-cookie');
  if (!sc) throw new Error('no set-cookie');
  const p = parseSetCookie(sc);
  if (!p) throw new Error('parse set-cookie');
  return `${p.name}=${p.value}`;
}

async function makeUser(
  db: Database,
  opts: { isAdmin: boolean; suffix?: string },
): Promise<{ id: string; email: string }> {
  const suffix = opts.suffix ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const [row] = await db
    .insert(users)
    .values({
      email: `${opts.isAdmin ? 'admin' : 'user'}-${suffix}@example.com`,
      isAdmin: opts.isAdmin,
    })
    .returning({ id: users.id, email: users.email });
  return row;
}

describe('admin user management', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('GET /admin/users is admin-only and returns last_seen', async () => {
    const admin = await makeUser(fx.db, { isAdmin: true });
    const user = await makeUser(fx.db, { isAdmin: false });

    // Non-admin → 403.
    const userCookie = await devCookie(fx.baseUrl, user.id);
    const forbidden = await fetch(`${fx.baseUrl}/api/admin/users`, {
      headers: { cookie: userCookie },
    });
    expect(forbidden.status).toBe(403);

    // Unauthenticated → 401.
    const anon = await fetch(`${fx.baseUrl}/api/admin/users`);
    expect(anon.status).toBe(401);

    // Admin → 200.
    const adminCookie = await devCookie(fx.baseUrl, admin.id);
    const ok = await fetch(`${fx.baseUrl}/api/admin/users`, {
      headers: { cookie: adminCookie },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      users: Array<{
        id: string;
        email: string;
        is_admin: boolean;
        last_seen_at: string | null;
        disabled_at: string | null;
      }>;
    };
    const u = body.users.find((r) => r.id === user.id);
    expect(u, 'user listed').toBeDefined();
    expect(u!.last_seen_at).not.toBeNull(); // dev-session set last_seen_at
    expect(u!.disabled_at).toBeNull();
  });

  it('PATCH /admin/users/:id updates name + isAdmin', async () => {
    const admin = await makeUser(fx.db, { isAdmin: true });
    const user = await makeUser(fx.db, { isAdmin: false });
    const adminCookie = await devCookie(fx.baseUrl, admin.id);

    const res = await fetch(`${fx.baseUrl}/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Promoted Person', isAdmin: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { name: string; is_admin: boolean };
    };
    expect(body.user.name).toBe('Promoted Person');
    expect(body.user.is_admin).toBe(true);
  });

  it('PATCH /admin/users/:id with only name leaves isAdmin alone', async () => {
    // The admin UI's inline rename sends just `{ name }` — make sure
    // that doesn't accidentally clear the existing isAdmin bit.
    const admin = await makeUser(fx.db, { isAdmin: true });
    const promotedUser = await makeUser(fx.db, { isAdmin: true });
    const adminCookie = await devCookie(fx.baseUrl, admin.id);

    const res = await fetch(`${fx.baseUrl}/api/admin/users/${promotedUser.id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Only' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { name: string; is_admin: boolean };
    };
    expect(body.user.name).toBe('Renamed Only');
    expect(body.user.is_admin).toBe(true);
  });

  it('PATCH /admin/users/:id rejects empty / whitespace name', async () => {
    const admin = await makeUser(fx.db, { isAdmin: true });
    const user = await makeUser(fx.db, { isAdmin: false });
    const adminCookie = await devCookie(fx.baseUrl, admin.id);

    const empty = await fetch(`${fx.baseUrl}/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(empty.status).toBe(400);
  });

  it('disable + enable: disabled user 401s, enable restores access', async () => {
    const admin = await makeUser(fx.db, { isAdmin: true });
    const user = await makeUser(fx.db, { isAdmin: false });
    const adminCookie = await devCookie(fx.baseUrl, admin.id);
    const userCookie = await devCookie(fx.baseUrl, user.id);

    // Pre-disable: user can call /me.
    const before = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: userCookie } });
    expect(before.status).toBe(200);

    // Disable.
    const dis = await fetch(`${fx.baseUrl}/api/admin/users/${user.id}/disable`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    expect(dis.status).toBe(204);

    // Now /me 401s with the same cookie — disabled_at gates resolveUser.
    const after = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: userCookie } });
    expect(after.status).toBe(401);

    // Enable.
    const en = await fetch(`${fx.baseUrl}/api/admin/users/${user.id}/enable`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    expect(en.status).toBe(204);

    // Mint a fresh cookie (the prior touch chain is dead) and confirm.
    const fresh = await devCookie(fx.baseUrl, user.id);
    const restored = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: fresh } });
    expect(restored.status).toBe(200);
  });

  it('cannot disable or delete your own account', async () => {
    const admin = await makeUser(fx.db, { isAdmin: true });
    const adminCookie = await devCookie(fx.baseUrl, admin.id);

    const dis = await fetch(`${fx.baseUrl}/api/admin/users/${admin.id}/disable`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    expect(dis.status).toBe(422);

    const del = await fetch(`${fx.baseUrl}/api/admin/users/${admin.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(del.status).toBe(422);
  });

  it('DELETE /admin/users/:id hard-deletes a user', async () => {
    const admin = await makeUser(fx.db, { isAdmin: true });
    const target = await makeUser(fx.db, { isAdmin: false });
    const adminCookie = await devCookie(fx.baseUrl, admin.id);

    const res = await fetch(`${fx.baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(204);

    const after = await fx.db.select({ id: users.id }).from(users).where(eq(users.id, target.id));
    expect(after).toHaveLength(0);

    // Re-delete is 404.
    const replay = await fetch(`${fx.baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(replay.status).toBe(404);
  });

  it('DELETE /admin/users/:id transfers owned docs to the deleting admin', async () => {
    const admin = await makeUser(fx.db, { isAdmin: true });
    const target = await makeUser(fx.db, { isAdmin: false });
    const adminCookie = await devCookie(fx.baseUrl, admin.id);

    // Seed three docs owned by the target — including a soft-deleted
    // one — so we cover both the live-list and admin-only views.
    const seeded = await fx.db
      .insert(docs)
      .values([
        { title: 'live-1', engine: 'latex', ownerId: target.id },
        { title: 'live-2', engine: 'typst', ownerId: target.id },
        {
          title: 'soft-deleted',
          engine: 'latex',
          ownerId: target.id,
          deletedAt: new Date(),
        },
      ])
      .returning({ id: docs.id, title: docs.title });
    expect(seeded).toHaveLength(3);

    const res = await fetch(`${fx.baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(204);

    // User is gone.
    const userAfter = await fx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, target.id));
    expect(userAfter).toHaveLength(0);

    // Every doc the user owned (including the soft-deleted one) now
    // belongs to the deleting admin. None vanished.
    for (const row of seeded) {
      const after = await fx.db
        .select({ id: docs.id, ownerId: docs.ownerId, title: docs.title })
        .from(docs)
        .where(eq(docs.id, row.id));
      expect(after).toHaveLength(1);
      expect(after[0]!.ownerId).toBe(admin.id);
      expect(after[0]!.title).toBe(row.title);
    }
  });
});
