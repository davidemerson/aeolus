import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BROWSER_RATE_LIMITS, MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

// Passphrase sign-in end to end: the bootstrap credential, the forced setup
// that follows it, lockout, and the admin reset. This is the whole way into a
// self-hosted instance, so it is tested against a real database and a real
// server rather than mocks.

const COOKIE_SECRET = 'passphrase-test-secret';
const STRONG = 'thicket lantern rowboat cobble sundial';
const ALSO_STRONG = 'harbour pumice fennel drawbridge kettle';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  close(): Promise<void>;
}

async function setup(loginLimit = 10_000): Promise<Fixtures> {
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
    // Every request in this file comes from 127.0.0.1, so the shipped per-IP
    // budget would exhaust itself on the fixtures. The limiter gets its own
    // test below, with its own server and a budget small enough to hit.
    browserRateLimits: {
      ...BROWSER_RATE_LIMITS,
      login: { max: loginLimit, timeWindow: '1 minute' },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    postgres,
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

let unique = 0;
function freshEmail(prefix: string): string {
  unique += 1;
  return `${prefix}-${Date.now()}-${unique}@example.com`;
}

let fx: Fixtures;

async function login(
  email: string,
  passphrase: string,
  baseUrl = fx.baseUrl,
): Promise<{ status: number; body: Record<string, unknown>; cookie: string | null }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, passphrase }),
  });
  const text = await res.text();
  const setCookie = res.headers.get('set-cookie');
  const parsed = setCookie ? parseSetCookie(setCookie) : null;
  return {
    status: res.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
    cookie: parsed ? `${parsed.name}=${parsed.value}` : null,
  };
}

/** An account with a known passphrase, already through setup. */
async function makeUser(
  prefix: string,
  opts: { isAdmin?: boolean; passphrase?: string } = {},
): Promise<{ id: string; email: string; passphrase: string; cookie: string }> {
  const email = freshEmail(prefix);
  const passphrase = opts.passphrase ?? STRONG;
  const { setPassphrase } = await import('@aeolus/api');
  const [row] = await fx.db
    .insert(users)
    .values({ email, isAdmin: opts.isAdmin ?? false, mustSetPassphrase: true })
    .returning({ id: users.id });
  // Go through the real setter so the stored record is exactly what a
  // production one is.
  await setPassphrase(fx.db, row.id, { next: passphrase });
  const signedIn = await login(email, passphrase);
  expect(signedIn.status).toBe(200);
  return { id: row.id, email, passphrase, cookie: signedIn.cookie as string };
}

beforeAll(async () => {
  fx = await setup();
}, 180_000);

afterAll(async () => {
  await fx?.close();
});

// Runs first, against an empty users table — which is the situation it is
// about. Everything below adds rows.
describe('first launch', () => {
  it('creates one administrator with a generated credential, then never again', async () => {
    const { bootstrapFirstAdmin } = await import('@aeolus/api');
    const email = freshEmail('bootstrap');

    const first = await bootstrapFirstAdmin(fx.db, email);
    expect(first.created).toBe(true);
    expect(first.email).toBe(email);
    expect(first.passphrase?.split(' ')).toHaveLength(6);

    // The generated credential works and lands in forced setup.
    const signedIn = await login(email, first.passphrase as string);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.must_set_passphrase).toBe(true);

    // Every later boot is a no-op — the guard that makes it safe to call from
    // all three processes on every start.
    const second = await bootstrapFirstAdmin(fx.db, freshEmail('bootstrap-again'));
    expect(second.created).toBe(false);
    expect(second.passphrase).toBeUndefined();
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with the right passphrase and sets a session cookie', async () => {
    const user = await makeUser('login-ok');
    const res = await login(user.email, user.passphrase);
    expect(res.status).toBe(200);
    expect(res.cookie).toBeTruthy();
    expect(res.body.must_set_passphrase).toBe(false);

    const me = await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: res.cookie as string } });
    expect(me.status).toBe(200);
  });

  it('is case- and space-insensitive about the email, never the passphrase', async () => {
    const user = await makeUser('login-case');
    expect((await login(`  ${user.email.toUpperCase()}  `, user.passphrase)).status).toBe(200);
    expect((await login(user.email, user.passphrase.toUpperCase())).status).toBe(401);
  });

  it('answers the same for a wrong passphrase and an address with no account', async () => {
    const user = await makeUser('login-enum');
    const wrong = await login(user.email, 'definitely not the passphrase');
    const missing = await login(freshEmail('nobody'), 'definitely not the passphrase');
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual(wrong.body);
  });

  it('locks the account after ten failures and says how long for', async () => {
    const user = await makeUser('login-lock');
    for (let i = 0; i < 10; i += 1) {
      expect((await login(user.email, `wrong ${i}`)).status).toBe(401);
    }
    const locked = await login(user.email, user.passphrase);
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('account_locked');

    // Still locked to the holder of the real credential — that is the point;
    // a lockout that the attacker can step around protects nothing.
    const [row] = await fx.db
      .select({ lockedUntil: users.lockedUntil, failedAttempts: users.failedAttempts })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.failedAttempts).toBeGreaterThanOrEqual(10);
    expect(row.lockedUntil).toBeTruthy();
  });

  it('clears the failure count on a success', async () => {
    const user = await makeUser('login-clear');
    await login(user.email, 'wrong once');
    await login(user.email, 'wrong twice');
    expect((await login(user.email, user.passphrase)).status).toBe(200);
    const [row] = await fx.db
      .select({ failedAttempts: users.failedAttempts })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.failedAttempts).toBe(0);
  });

  it('refuses a disabled account, but only once the passphrase is right', async () => {
    const user = await makeUser('login-disabled');
    await fx.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    // Wrong passphrase on a disabled account still reads as a wrong
    // passphrase: "this account is disabled" is information.
    expect((await login(user.email, 'wrong')).status).toBe(401);
    const right = await login(user.email, user.passphrase);
    expect(right.status).toBe(403);
    expect(right.body.error).toBe('account_disabled');
  });
});

describe('forced setup', () => {
  it('gates every route except the setup ones until a passphrase is chosen', async () => {
    const email = freshEmail('forced');
    const { generateInitialCredential } = await import('@aeolus/api');
    const { passphrase, hash } = await generateInitialCredential();
    await fx.db.insert(users).values({ email, passphraseHash: hash, mustSetPassphrase: true });

    const signedIn = await login(email, passphrase);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.must_set_passphrase).toBe(true);
    const cookie = signedIn.cookie as string;

    // /me answers, so the SPA can boot and route to the setup screen.
    expect((await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie } })).status).toBe(200);

    const docs = await fetch(`${fx.baseUrl}/api/docs`, { headers: { cookie } });
    expect(docs.status).toBe(403);
    expect(((await docs.json()) as { error: string }).error).toBe('passphrase_setup_required');

    // Setting one does not need the current passphrase: the login that got
    // here already proved it.
    const set = await fetch(`${fx.baseUrl}/api/auth/passphrase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ next: ALSO_STRONG }),
    });
    expect(set.status).toBe(204);

    const after = await fetch(`${fx.baseUrl}/api/docs`, { headers: { cookie } });
    expect(after.status).toBe(200);
    // And the printed credential is spent.
    expect((await login(email, passphrase)).status).toBe(401);
    expect((await login(email, ALSO_STRONG)).body.must_set_passphrase).toBe(false);
  });

  it('rejects a weak choice with every reason, and changes nothing', async () => {
    const email = freshEmail('weak');
    const { generateInitialCredential } = await import('@aeolus/api');
    const { passphrase, hash } = await generateInitialCredential();
    await fx.db.insert(users).values({ email, passphraseHash: hash, mustSetPassphrase: true });
    const cookie = (await login(email, passphrase)).cookie as string;

    const res = await fetch(`${fx.baseUrl}/api/auth/passphrase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ next: 'password' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; problems: string[] };
    expect(body.error).toBe('weak_passphrase');
    expect(body.problems.length).toBeGreaterThan(0);
    // The generated credential still works, so a failed attempt cannot lock
    // someone out of their own setup.
    expect((await login(email, passphrase)).status).toBe(200);
  });
});

describe('POST /api/auth/passphrase (voluntary change)', () => {
  it('requires the current passphrase once one has been chosen', async () => {
    const user = await makeUser('change');

    const without = await fetch(`${fx.baseUrl}/api/auth/passphrase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify({ next: ALSO_STRONG }),
    });
    expect(without.status).toBe(401);

    const wrong = await fetch(`${fx.baseUrl}/api/auth/passphrase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify({ current: 'not it at all', next: ALSO_STRONG }),
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${fx.baseUrl}/api/auth/passphrase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify({ current: user.passphrase, next: ALSO_STRONG }),
    });
    expect(ok.status).toBe(204);
    expect((await login(user.email, ALSO_STRONG)).status).toBe(200);
    expect((await login(user.email, user.passphrase)).status).toBe(401);
  });

  it('refuses the passphrase already in use', async () => {
    const user = await makeUser('same');
    const res = await fetch(`${fx.baseUrl}/api/auth/passphrase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify({ current: user.passphrase, next: user.passphrase }),
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/auth/policy', () => {
  it('is readable signed out, and its suggestion satisfies its own rule', async () => {
    const res = await fetch(`${fx.baseUrl}/api/auth/policy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rule: string; suggestion: string };
    expect(body.rule.length).toBeGreaterThan(0);
    expect(body.suggestion.split(' ')).toHaveLength(6);
  });
});

describe('admin passphrase reset', () => {
  it('issues a new credential, forces setup again, and kills the old sessions', async () => {
    const admin = await makeUser('reset-admin', { isAdmin: true });
    const victim = await makeUser('reset-victim');

    // The victim's session works before the reset.
    expect(
      (await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: victim.cookie } })).status,
    ).toBe(200);

    const res = await fetch(`${fx.baseUrl}/api/admin/users/${victim.id}/reset-passphrase`, {
      method: 'POST',
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const { passphrase } = (await res.json()) as { passphrase: string };
    expect(passphrase.split(' ')).toHaveLength(6);

    // Old passphrase gone, old session gone, new credential lands in setup.
    expect((await login(victim.email, victim.passphrase)).status).toBe(401);
    expect(
      (await fetch(`${fx.baseUrl}/api/me`, { headers: { cookie: victim.cookie } })).status,
    ).toBe(401);
    const back = await login(victim.email, passphrase);
    expect(back.status).toBe(200);
    expect(back.body.must_set_passphrase).toBe(true);
  });

  it('is refused to a non-admin', async () => {
    const nobody = await makeUser('reset-nobody');
    const target = await makeUser('reset-target');
    const res = await fetch(`${fx.baseUrl}/api/admin/users/${target.id}/reset-passphrase`, {
      method: 'POST',
      headers: { cookie: nobody.cookie },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/users', () => {
  it('creates an account with a one-time credential that forces setup', async () => {
    const admin = await makeUser('create-admin', { isAdmin: true });
    const email = freshEmail('created');

    const res = await fetch(`${fx.baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ email, name: 'New Person' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { email: string; is_admin: boolean };
      passphrase: string;
    };
    expect(body.user.email).toBe(email);
    expect(body.user.is_admin).toBe(false);

    const signedIn = await login(email, body.passphrase);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.must_set_passphrase).toBe(true);
  });

  it('refuses a duplicate address', async () => {
    const admin = await makeUser('create-dupe', { isAdmin: true });
    const res = await fetch(`${fx.baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ email: admin.email }),
    });
    expect(res.status).toBe(409);
  });

  it('is refused to a non-admin', async () => {
    const nobody = await makeUser('create-nobody');
    const res = await fetch(`${fx.baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: nobody.cookie },
      body: JSON.stringify({ email: freshEmail('never') }),
    });
    expect(res.status).toBe(403);
  });
});

describe('sign-in rate limit', () => {
  it('stops a spray from one address before the account lockout would', async () => {
    // Its own server and its own database: a budget this small would break
    // every other test in the file.
    const small = await setup(5);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        statuses.push((await login('nobody@example.com', `guess ${i}`, small.baseUrl)).status);
      }
      // The first five are refused on the credential; the rest never reach it.
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses.slice(5)).toEqual([429, 429]);
    } finally {
      await small.close();
    }
  }, 180_000);
});
