import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { apiTokens, db as makeDb, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

/** `Response.json()` is `unknown` under this tsconfig; assert once, here. */
async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const COOKIE_SECRET = 'v1-auth-test-secret';

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
async function signIn(isAdmin = false) {
  const email = `v1-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email, isAdmin }).returning({ id: users.id });
  const res = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(res.headers.get('set-cookie') ?? '')!;
  return { cookie: `${c.name}=${c.value}`, userId: user.id, email };
}

async function mintToken(scope: 'read' | 'write' = 'read') {
  const me = await signIn();
  const res = await fetch(`${fx.baseUrl}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: me.cookie },
    body: JSON.stringify({ name: `t-${scope}`, scope }),
  });
  const body = await json<{ token: string; created: { id: string } }>(res);
  return { ...me, token: body.token, tokenId: body.created.id };
}

function v1(path: string, init: RequestInit = {}) {
  return fetch(`${fx.baseUrl}/api/v1${path}`, init);
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('/api/v1 authentication', () => {
  it('401s with no credential, and says how to present one', async () => {
    const res = await v1('/me');
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error).toBe('unauthenticated');
    expect(body.message).toContain('Bearer');
  });

  it.each([
    ['garbage', 'not-a-token'],
    ['a token shaped for a different application', 'other_0123456789abcdef_' + 'x'.repeat(43)],
    ['the right prefix, wrong shape', 'aeolus_zzzz_short'],
    ['a well-formed id that was never minted', 'aeolus_0123456789abcdef_' + 'x'.repeat(43)],
  ])('401s on %s', async (_label, token) => {
    const res = await v1('/me', { headers: bearer(token) });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('unauthenticated');
  });

  it('401s a real id presented with the wrong secret', async () => {
    const { tokenId } = await mintToken();
    const res = await v1('/me', {
      headers: bearer(`aeolus_${tokenId}_${'x'.repeat(43)}`),
    });
    expect(res.status).toBe(401);
  });

  it('authenticates a valid token AS its minting user', async () => {
    const t = await mintToken('read');
    const res = await v1('/me', { headers: bearer(t.token) });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      user: { id: t.userId, email: t.email, is_admin: false },
      token: { id: t.tokenId, scope: 'read' },
    });
  });

  it('does NOT accept a session cookie — this plane is tokens only', async () => {
    const me = await signIn();
    const res = await v1('/me', { headers: { cookie: me.cookie } });
    expect(res.status).toBe(401);
  });

  it('401s once the token is revoked', async () => {
    const t = await mintToken();
    expect((await v1('/me', { headers: bearer(t.token) })).status).toBe(200);
    await fetch(`${fx.baseUrl}/api/tokens/${t.tokenId}`, {
      method: 'DELETE',
      headers: { cookie: t.cookie },
    });
    expect((await v1('/me', { headers: bearer(t.token) })).status).toBe(401);
  });

  it('401s once the owner is disabled — a token dies with its user', async () => {
    const t = await mintToken();
    expect((await v1('/me', { headers: bearer(t.token) })).status).toBe(200);
    await fx.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, t.userId));
    expect((await v1('/me', { headers: bearer(t.token) })).status).toBe(401);
  });

  it('401s once the owner is deleted', async () => {
    const t = await mintToken();
    await fx.db.delete(users).where(eq(users.id, t.userId));
    expect((await v1('/me', { headers: bearer(t.token) })).status).toBe(401);
  });
});

describe('/api/v1 scope gate', () => {
  it('lets a read token read', async () => {
    const t = await mintToken('read');
    expect((await v1('/me', { headers: bearer(t.token) })).status).toBe(200);
  });

  it('refuses a read token on a write method with 403, not 401', async () => {
    const t = await mintToken('read');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await v1('/me', { method, headers: bearer(t.token) });
      // 403 and not 401 is the point: the credential is valid, so retrying
      // with a fresh one would loop forever.
      expect(res.status).toBe(403);
      const body = await json(res);
      expect(body.error).toBe('read_only_token');
      expect(body.scope).toBe('read');
    }
  });

  it('lets a write token through the gate', async () => {
    const t = await mintToken('write');
    // 404 from the router (no such v1 write route yet) proves it passed the
    // scope gate — a refusal would have been 403 before routing.
    const res = await v1('/me', { method: 'POST', headers: bearer(t.token) });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  // The property that matters most: a row carrying a scope nobody planned for
  // must behave as read-only, never as unrestricted.
  it('treats an unrecognised stored scope as read-only', async () => {
    const t = await mintToken('write');
    // Bypass the CHECK constraint the way a bad migration or a hand-edit would
    // not be able to — so drop it first, then write the bogus value.
    await fx.db.execute(sql`ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_scope_check`);
    await fx.db.update(apiTokens).set({ scope: 'superuser' }).where(eq(apiTokens.id, t.tokenId));

    const read = await v1('/me', { headers: bearer(t.token) });
    expect(read.status).toBe(200);
    expect((await json<{ token: { scope: string } }>(read)).token.scope).toBe('read');

    const write = await v1('/me', { method: 'POST', headers: bearer(t.token) });
    expect(write.status).toBe(403);

    // Put the row back inside the constraint's domain before restoring it —
    // ALTER TABLE ... ADD CONSTRAINT validates existing rows.
    await fx.db.delete(apiTokens).where(eq(apiTokens.id, t.tokenId));
    await fx.db.execute(
      sql`ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope in ('read','write'))`,
    );
  });
});

describe('/api/v1 last_used_at', () => {
  it('stamps on first use and then throttles', async () => {
    const t = await mintToken();
    const read = async () => {
      const [row] = await fx.db
        .select({ lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, t.tokenId));
      return row.lastUsedAt;
    };
    expect(await read()).toBeNull();

    await v1('/me', { headers: bearer(t.token) });
    // The stamp is best-effort and not awaited by the request, so give it a
    // moment rather than racing it.
    await new Promise((r) => setTimeout(r, 250));
    const first = await read();
    expect(first).not.toBeNull();

    await v1('/me', { headers: bearer(t.token) });
    await new Promise((r) => setTimeout(r, 250));
    // Inside the 5-minute window the second call must not move it.
    expect((await read())!.getTime()).toBe(first!.getTime());
  });
});

describe('/api/v1 routing', () => {
  it('returns JSON, not the SPA shell, for an unknown v1 path', async () => {
    const t = await mintToken();
    const res = await v1('/nope', { headers: bearer(t.token) });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<!doctype html');
  });

  // The gate covers the PREFIX, not just the routes that happen to exist.
  // Without a plugin-scoped notFoundHandler, Fastify answers an unmatched path
  // from the root handler without ever running this plane's onRequest hook —
  // which would tell an anonymous caller which routes exist, and would let a
  // read-scope token skip the scope gate on any path with no route.
  it('asks for a credential before admitting whether a v1 route exists', async () => {
    const res = await v1('/nope');
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('unauthenticated');
  });

  it('applies the scope gate to unmatched paths too', async () => {
    const t = await mintToken('read');
    const res = await v1('/nope', { method: 'POST', headers: bearer(t.token) });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('read_only_token');
  });

  it('does not leak v1 auth onto the browser plane', async () => {
    const me = await signIn();
    const res = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: me.cookie } });
    expect(res.status).toBe(200);
  });
});
