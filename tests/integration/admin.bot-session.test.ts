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
  const cs = postgres.getConnectionUri();
  await runMigrations(cs);
  const { db, pool } = makeDb({ connectionString: cs });
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'bot-session-test-secret',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    postgres,
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    dbPool: pool,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function adminCookie(baseUrl: string, db: Database): Promise<string> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const [u] = await db
    .insert(users)
    .values({ email: `admin-${suffix}@example.com`, isAdmin: true })
    .returning({ id: users.id });
  const r = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: u.id }),
  });
  const sc = r.headers.get('set-cookie');
  if (!sc) throw new Error('no set-cookie');
  const p = parseSetCookie(sc);
  if (!p) throw new Error('parse');
  return `${p.name}=${p.value}`;
}

describe('POST /admin/bot-session', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('creates a bot user and mints a non-rotating cookie', async () => {
    const cookie = await adminCookie(fx.baseUrl, fx.db);
    const email = `claude-bot-${Date.now()}@example.com`;
    const r = await fetch(`${fx.baseUrl}/api/admin/bot-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ email, name: 'Claude Bot', is_admin: true }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      user_id: string;
      cookie_value: string;
      cookie_header: string;
    };
    expect(body.user_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.cookie_header).toBe(`aeolus_session=${body.cookie_value}`);

    // The minted cookie authenticates /me — same code path the SPA uses.
    const me1 = await fetch(`${fx.baseUrl}/api/me`, {
      headers: { cookie: body.cookie_header },
    });
    expect(me1.status).toBe(200);
    const me1Cookie = me1.headers.get('set-cookie');
    expect(me1Cookie).toBeTruthy();
    // Critical bot-session property: the rotated cookie equals the
    // original one (no rotation) so the caller can keep using the
    // same value across many calls.
    const rotated = decodeURIComponent(me1Cookie!.match(/aeolus_session=([^;]+);/)![1]);
    expect(rotated).toBe(body.cookie_value);

    // Hit /me a few more times — still the same token.
    for (let i = 0; i < 3; i += 1) {
      const r2 = await fetch(`${fx.baseUrl}/api/me`, {
        headers: { cookie: body.cookie_header },
      });
      expect(r2.status).toBe(200);
      const sc2 = r2.headers.get('set-cookie');
      const rot2 = decodeURIComponent(sc2!.match(/aeolus_session=([^;]+);/)![1]);
      expect(rot2).toBe(body.cookie_value);
    }

    // Bot user exists with the right shape.
    const { rows } = await fx.dbPool.query<{
      email: string;
      is_admin: boolean;
    }>('SELECT email, is_admin FROM users WHERE id = $1', [body.user_id]);
    expect(rows[0]!.email).toBe(email);
    expect(rows[0]!.is_admin).toBe(true);
  });

  it('reuses an existing user when the email matches', async () => {
    const cookie = await adminCookie(fx.baseUrl, fx.db);
    const email = `existing-bot-${Date.now()}@example.com`;
    const [u] = await fx.db
      .insert(users)
      .values({ email, isAdmin: false, name: 'Existing' })
      .returning({ id: users.id });

    const r = await fetch(`${fx.baseUrl}/api/admin/bot-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ email, is_admin: true }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { user_id: string };
    expect(body.user_id).toBe(u.id);
    // is_admin escalation when requested
    const { rows } = await fx.dbPool.query<{ is_admin: boolean }>(
      'SELECT is_admin FROM users WHERE id = $1',
      [u.id],
    );
    expect(rows[0]!.is_admin).toBe(true);
  });

  it('non-admin cannot mint', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [u] = await fx.db
      .insert(users)
      .values({ email: `not-admin-${suffix}@example.com`, isAdmin: false })
      .returning({ id: users.id });
    const sr = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: u.id }),
    });
    const cookie = sr.headers.get('set-cookie')!.match(/aeolus_session=([^;]+);/)![0];

    const r = await fetch(`${fx.baseUrl}/api/admin/bot-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ email: 'someone@example.com' }),
    });
    expect(r.status).toBe(403);
  });
});
