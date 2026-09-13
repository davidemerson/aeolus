import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

/** `Response.json()` is `unknown` under this tsconfig; assert once, here. */
async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const COOKIE_SECRET = 'v1-ratelimit-test-secret';

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
    cookieSecret: COOKIE_SECRET,
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
async function mintToken(): Promise<string> {
  const email = `rl-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email }).returning({ id: users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
  const res = await fetch(`${fx.baseUrl}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${c.name}=${c.value}` },
    body: JSON.stringify({ name: `rl-${seq}`, scope: 'read' }),
  });
  return (await json(res)).token as string;
}

// The plane's default budget. Kept in step with V1_RATE_LIMITS.default in
// apps/api/src/v1/plugin.ts — if that changes and this is not updated, this
// suite fails loudly rather than silently asserting nothing.
const DEFAULT_LIMIT = 120;

async function hammer(token: string, n: number): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${fx.baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    codes.push(res.status);
  }
  return codes;
}

describe('/api/v1 rate limiting', () => {
  it('allows the budget and then 429s, with a retry-after', async () => {
    const token = await mintToken();
    const codes = await hammer(token, DEFAULT_LIMIT);
    expect(codes.every((c) => c === 200)).toBe(true);

    const over = await fetch(`${fx.baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
    expect((await json<{ error: string }>(over)).error).toBe('rate_limited');
  }, 60_000);

  it('buckets per credential — one exhausted token does not throttle another', async () => {
    const hot = await mintToken();
    const cold = await mintToken();
    await hammer(hot, DEFAULT_LIMIT + 1);

    const hotAgain = await fetch(`${fx.baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${hot}` },
    });
    expect(hotAgain.status).toBe(429);

    const coldRes = await fetch(`${fx.baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${cold}` },
    });
    expect(coldRes.status).toBe(200);
  }, 60_000);

  it('does not rate-limit the browser plane', async () => {
    // The limiter is registered inside the v1 plugin with global:false, so the
    // cookie plane must be untouched by it.
    const email = `rl-browser-${Date.now()}@example.com`;
    const [user] = await fx.db.insert(users).values({ email }).returning({ id: users.id });
    const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    });
    const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
    let cookie = `${c.name}=${c.value}`;

    for (let i = 0; i < DEFAULT_LIMIT + 5; i++) {
      const res = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie } });
      expect(res.status).toBe(200);
      // Sessions rotate on every request — carry the new cookie forward or the
      // next call 401s and this asserts nothing.
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const next = parseSetCookie(setCookie);
        if (next) cookie = `${next.name}=${next.value}`;
      }
    }
  }, 60_000);
});
