import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { apiTokens, auditEvents, db as makeDb, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

/** `Response.json()` is `unknown` under this tsconfig; assert once, here. */
async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const COOKIE_SECRET = 'tokens-mint-test-secret';

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
async function signIn(isAdmin = false): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `tok-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email, isAdmin }).returning({ id: users.id });
  const res = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const parsed = parseSetCookie(res.headers.get('set-cookie') ?? '');
  return { cookie: `${parsed!.name}=${parsed!.value}`, userId: user.id, email };
}

async function mint(cookie: string, body: unknown) {
  return fetch(`${fx.baseUrl}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tokens — minting', () => {
  it('returns the plaintext exactly once and stores only its hash', async () => {
    const me = await signIn();
    const res = await mint(me.cookie, { name: 'ci-publish', scope: 'write' });
    expect(res.status).toBe(201);
    const body = await json<{ token: string; created: Record<string, unknown> }>(res);

    expect(body.token).toMatch(/^aeolus_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(body.created).toMatchObject({
      id: body.token.split('_')[1],
      name: 'ci-publish',
      scope: 'write',
      created_by: me.userId,
      created_by_email: me.email,
      last_used_at: null,
    });
    // The response must not leak the verification input.
    expect(JSON.stringify(body.created)).not.toContain('token_hash');

    // Nothing anywhere in the row is the plaintext.
    const [row] = await fx.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, body.created.id as string));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(row).join('|')).not.toContain(body.token);

    // And it is never returned again.
    const list = await fetch(`${fx.baseUrl}/api/tokens`, { headers: { cookie: me.cookie } });
    expect(JSON.stringify(await list.json())).not.toContain(body.token);
  });

  it('defaults to the read scope — least privilege without asking', async () => {
    const me = await signIn();
    const res = await mint(me.cookie, { name: 'no-scope-given' });
    expect(res.status).toBe(201);
    expect((await json<{ created: { scope: string } }>(res)).created.scope).toBe('read');
  });

  it('rejects a bad name or an unknown scope', async () => {
    const me = await signIn();
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x', scope: 'admin' }]) {
      const res = await mint(me.cookie, body);
      expect(res.status).toBe(400);
      expect((await json<{ error: string }>(res)).error).toBe('invalid_body');
    }
  });

  it('refuses a cross-site mint even with a valid cookie', async () => {
    const me = await signIn();
    const res = await fetch(`${fx.baseUrl}/api/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: me.cookie,
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ name: 'csrf-attempt' }),
    });
    expect(res.status).toBe(403);
  });

  it('401s an anonymous caller on every token route', async () => {
    for (const [method, path] of [
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens'],
      ['DELETE', '/api/tokens/0123456789abcdef'],
    ] as const) {
      // Only send a content-type when there is a body: Fastify rejects an
      // empty body declared as JSON with a 400, before any auth hook runs,
      // which would make this assertion pass for the wrong reason.
      const res = await fetch(`${fx.baseUrl}${path}`, {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: 'x' }),
            }
          : {}),
      });
      expect(res.status).toBe(401);
    }
  });

  it('audits the mint', async () => {
    const me = await signIn();
    const body = await json<{
      token: string;
      created: { id: string; name: string; scope: string };
    }>(await mint(me.cookie, { name: 'audited', scope: 'write' }));
    const rows = await fx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, body.created.id));
    expect(rows.map((r) => r.action)).toContain('token.mint');
    expect(rows[0].metadata).toMatchObject({ name: 'audited', scope: 'write' });
    expect(rows[0].actorEmail).toBe(me.email);
  });
});

describe('GET/DELETE /api/tokens — visibility and revocation', () => {
  it('shows every token to every signed-in user, not just their own', async () => {
    const alice = await signIn();
    const bob = await signIn();
    const mintedByAlice = await json<{
      token: string;
      created: { id: string; name: string; scope: string };
    }>(await mint(alice.cookie, { name: 'alice-key' }));

    const res = await fetch(`${fx.baseUrl}/api/tokens`, { headers: { cookie: bob.cookie } });
    expect(res.status).toBe(200);
    const { tokens } = await json<{ tokens: Array<Record<string, unknown>> }>(res);
    const seen = tokens.find((t) => t.id === mintedByAlice.created.id);
    expect(seen).toMatchObject({ name: 'alice-key', created_by_email: alice.email });
  });

  it('lets a non-admin revoke someone else’s token, and audits who did it', async () => {
    const alice = await signIn();
    const bob = await signIn(false);
    const minted = await json<{
      token: string;
      created: { id: string; name: string; scope: string };
    }>(await mint(alice.cookie, { name: 'shared-infra' }));

    const res = await fetch(`${fx.baseUrl}/api/tokens/${minted.created.id}`, {
      method: 'DELETE',
      headers: { cookie: bob.cookie },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    const [gone] = await fx.db.select().from(apiTokens).where(eq(apiTokens.id, minted.created.id));
    expect(gone).toBeUndefined();

    const audit = await fx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, minted.created.id));
    const revoke = audit.find((r) => r.action === 'token.revoke');
    expect(revoke?.actorEmail).toBe(bob.email);
    // The owner survives the row it described.
    expect(revoke?.metadata).toMatchObject({ owner_email: alice.email });
  });

  it('404s an unknown or malformed id, and a second revoke', async () => {
    const me = await signIn();
    const minted = await json<{
      token: string;
      created: { id: string; name: string; scope: string };
    }>(await mint(me.cookie, { name: 'once' }));

    const first = await fetch(`${fx.baseUrl}/api/tokens/${minted.created.id}`, {
      method: 'DELETE',
      headers: { cookie: me.cookie },
    });
    expect(first.status).toBe(204);

    for (const id of [minted.created.id, '0123456789abcdef', 'not-an-id', '../../etc/passwd']) {
      const res = await fetch(`${fx.baseUrl}/api/tokens/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { cookie: me.cookie },
      });
      expect(res.status).toBe(404);
    }
  });

  it('revokes a user’s tokens when the user row goes (FK cascade)', async () => {
    const doomed = await signIn();
    const minted = await json<{
      token: string;
      created: { id: string; name: string; scope: string };
    }>(await mint(doomed.cookie, { name: 'dies-with-owner' }));

    await fx.db.delete(users).where(eq(users.id, doomed.userId));

    const [gone] = await fx.db.select().from(apiTokens).where(eq(apiTokens.id, minted.created.id));
    expect(gone).toBeUndefined();
  });
});
