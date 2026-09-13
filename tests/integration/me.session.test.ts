import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

const COOKIE_SECRET = 'me-session-test-secret';

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
    cookieSecret: COOKIE_SECRET,
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

async function newSession(
  baseUrl: string,
  db: Database,
): Promise<{
  cookie: string;
  userId: string;
  email: string;
}> {
  const email = `signout-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, isAdmin: false })
    .returning({ id: users.id });
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  if (res.status !== 201) throw new Error(`dev sessions: ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('parse set-cookie');
  return { cookie: `${parsed.name}=${parsed.value}`, userId: user.id, email };
}

describe('DELETE /api/me/session (sign out)', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('clears the cookie and invalidates future requests with the same cookie', async () => {
    const { cookie } = await newSession(fx.baseUrl, fx.db);

    // /me works while signed in (and rotates the cookie — we keep
    // using the original here because our DELETE happens against
    // that same plaintext token).
    const meBefore = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie } });
    expect(meBefore.status).toBe(200);

    const out = await fetch(`${fx.baseUrl}/api/me/session`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(out.status).toBe(204);
    const cleared = out.headers.get('set-cookie');
    // The cookie response must explicitly clear the cookie so a
    // browser flushes it client-side. clearCookie() emits an
    // expired Max-Age / Expires.
    expect(cleared, 'set-cookie present').toBeTruthy();
    expect(cleared!.toLowerCase()).toContain('max-age=0');

    // /me with the now-destroyed token returns 401. The token-store
    // keeps a 10s rotation grace for the prior token after a touch,
    // but destroy() drops both the rotated row and any predecessor
    // hashed under the same plaintext.
    const meAfter = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie } });
    expect(meAfter.status).toBe(401);
  });

  it('idempotent: 204 even without a cookie', async () => {
    const out = await fetch(`${fx.baseUrl}/api/me/session`, { method: 'DELETE' });
    expect(out.status).toBe(204);
  });

  it('idempotent: 204 with an unknown / forged cookie', async () => {
    const out = await fetch(`${fx.baseUrl}/api/me/session`, {
      method: 'DELETE',
      headers: { cookie: 'aeolus_session=not-a-real-token' },
    });
    expect(out.status).toBe(204);
  });
});
