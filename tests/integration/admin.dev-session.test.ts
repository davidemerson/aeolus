import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, users, type Database } from '@aeolus/db';
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
    cookieSecret: 'dev-session-test-secret',
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

async function bootstrapCookie(baseUrl: string, userId: string): Promise<string> {
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

describe('POST /admin/dev-session', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('admin mints a session usable on subsequent requests', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [admin] = await fx.db
      .insert(users)
      .values({ email: `ds-admin-${suffix}@example.com`, isAdmin: true })
      .returning({ id: users.id, email: users.email });
    const adminCookie = await bootstrapCookie(fx.baseUrl, admin.id);

    const res = await fetch(`${fx.baseUrl}/api/admin/dev-session`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      cookie_name: string;
      cookie_value: string;
      cookie_header: string;
    };
    expect(body.cookie_name).toBe('aeolus_session');
    expect(body.cookie_header).toBe(`aeolus_session=${body.cookie_value}`);

    // The minted cookie must round-trip through /me successfully —
    // proving that signCookie produces a value request.unsignCookie
    // accepts.
    const meRes = await fetch(`${fx.baseUrl}/api/me`, {
      headers: { cookie: body.cookie_header },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { user: { id: string } };
    expect(me.user.id).toBe(admin.id);
  });

  it('non-admin cannot mint', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [user] = await fx.db
      .insert(users)
      .values({ email: `ds-user-${suffix}@example.com`, isAdmin: false })
      .returning({ id: users.id });
    const userCookie = await bootstrapCookie(fx.baseUrl, user.id);

    const res = await fetch(`${fx.baseUrl}/api/admin/dev-session`, {
      method: 'POST',
      headers: { cookie: userCookie },
    });
    expect(res.status).toBe(403);
  });

  it('unauthenticated cannot mint', async () => {
    const res = await fetch(`${fx.baseUrl}/api/admin/dev-session`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });
});
