import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BROWSER_RATE_LIMITS, MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { auditEvents, db as makeDb, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

/** `Response.json()` is `unknown` under this tsconfig; assert once, here. */
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
    cookieSecret: 'v1-docs-test-secret',
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
interface Persona {
  userId: string;
  email: string;
  cookie: string;
  read: string;
  write: string;
}

async function persona(isAdmin = false): Promise<Persona> {
  const email = `v1docs-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email, isAdmin }).returning({ id: users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
  const cookie = `${c.name}=${c.value}`;
  const mint = async (scope: 'read' | 'write') => {
    const res = await fetch(`${fx.baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: `${scope}-${seq}`, scope }),
    });
    return (await json<{ token: string }>(res)).token;
  };
  return {
    userId: user.id,
    email,
    cookie,
    read: await mint('read'),
    write: await mint('write'),
  };
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

async function seedDoc(admin: Persona, title = `doc-${seq++}`): Promise<string> {
  const res = await v1(admin.write, '/docs', {
    method: 'POST',
    body: JSON.stringify({ title, engine: 'latex' }),
  });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

describe('/api/v1/docs — lifecycle', () => {
  it('creates, reads, renames, archives and deletes', async () => {
    const admin = await persona(true);
    const id = await seedDoc(admin, 'lifecycle');

    const got = await json<{ doc: Record<string, unknown> }>(await v1(admin.read, `/docs/${id}`));
    expect(got.doc).toMatchObject({
      id,
      title: 'lifecycle',
      engine: 'latex',
      owner_id: admin.userId,
      archived_at: null,
      deleted_at: null,
    });

    const renamed = await json<{ doc: { title: string } }>(
      await v1(admin.write, `/docs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: 'renamed' }),
      }),
    );
    expect(renamed.doc.title).toBe('renamed');

    const archived = await json<{ doc: { archived_at: string | null } }>(
      await v1(admin.write, `/docs/${id}/archive`, { method: 'POST' }),
    );
    expect(archived.doc.archived_at).not.toBeNull();

    // Archive is a doc-level lock: a write bounces off it even for the owner.
    const blocked = await v1(admin.write, `/docs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(blocked.status).toBe(422);
    expect((await json<{ error: string }>(blocked)).error).toBe('archived');

    const unarchived = await json<{ doc: { archived_at: string | null } }>(
      await v1(admin.write, `/docs/${id}/unarchive`, { method: 'POST' }),
    );
    expect(unarchived.doc.archived_at).toBeNull();

    expect((await v1(admin.write, `/docs/${id}`, { method: 'DELETE' })).status).toBe(204);

    // Soft delete. It leaves the default listing...
    const listed = (
      await json<{ docs: Array<{ id: string }> }>(await v1(admin.read, '/docs'))
    ).docs.map((d) => d.id);
    expect(listed).not.toContain(id);

    // ...but an ADMIN can still fetch it, and see it with include_deleted.
    // That is deliberate, not an oversight: `resolveRoleAndDoc` checks
    // `isAdmin` BEFORE `deletedAt`, which is exactly what makes undelete and
    // the admin's include_deleted view possible.
    const stillThere = await json<{ doc: { deleted_at: string | null } }>(
      await v1(admin.read, `/docs/${id}`),
    );
    expect(stillThere.doc.deleted_at).not.toBeNull();
    expect(
      (
        await json<{ docs: Array<{ id: string }> }>(
          await v1(admin.read, '/docs?include_deleted=true&status=all'),
        )
      ).docs.map((d) => d.id),
    ).toContain(id);
  });

  it('hides a soft-deleted document from everyone who is not an admin', async () => {
    const admin = await persona(true);
    const owner = await persona(false);
    const id = await seedDoc(admin);
    // Hand the document to a non-admin owner, then delete it as them.
    await fx.db.update(docs).set({ ownerId: owner.userId }).where(eq(docs.id, id));
    expect((await v1(owner.write, `/docs/${id}`, { method: 'DELETE' })).status).toBe(204);

    // Its own owner can no longer see it — for a non-admin the deletedAt check
    // comes first, so the role resolves to none and ADR 0003 makes that a 404.
    expect((await v1(owner.read, `/docs/${id}`)).status).toBe(404);
    expect(
      (
        await json<{ docs: Array<{ id: string }> }>(
          await v1(owner.read, '/docs?include_deleted=true&status=all'),
        )
      ).docs.map((d) => d.id),
    ).not.toContain(id);
  });

  it('archive and unarchive are idempotent', async () => {
    const admin = await persona(true);
    const id = await seedDoc(admin);
    for (const verb of ['archive', 'archive', 'unarchive', 'unarchive']) {
      expect((await v1(admin.write, `/docs/${id}/${verb}`, { method: 'POST' })).status).toBe(200);
    }
  });

  it('refuses create to a non-admin however wide the scope', async () => {
    const user = await persona(false);
    const res = await v1(user.write, '/docs', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', engine: 'latex' }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('forbidden');
  });

  it('rejects a malformed body and a malformed id', async () => {
    const admin = await persona(true);
    const bad = await v1(admin.write, '/docs', {
      method: 'POST',
      body: JSON.stringify({ title: '', engine: 'word' }),
    });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toBe('invalid_request');

    expect((await v1(admin.read, '/docs/not-a-uuid')).status).toBe(400);
  });
});

describe('/api/v1/docs — scope is NOT the ACL', () => {
  it('a read token cannot write, and says so as 403 read_only_token', async () => {
    const admin = await persona(true);
    const id = await seedDoc(admin);
    const res = await v1(admin.read, `/docs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('read_only_token');
  });

  // The property a consumer will get wrong: a write-scope token is still
  // bounded by what its OWNER can do. Scope and the document ACL are separate
  // gates and both apply.
  it('a WRITE token minted by a viewer still cannot write the document', async () => {
    const admin = await persona(true);
    const viewer = await persona(false);
    const id = await seedDoc(admin);

    expect(
      (
        await v1(admin.write, `/docs/${id}/collaborators`, {
          method: 'POST',
          body: JSON.stringify({ email: viewer.email, role: 'viewer' }),
        })
      ).status,
    ).toBe(201);

    // It can read...
    expect((await v1(viewer.read, `/docs/${id}`)).status).toBe(200);

    // ...but its write-scope token is refused by the ACL, not the scope gate.
    const res = await v1(viewer.write, `/docs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'viewer wrote this' }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('forbidden');
  });

  it('a token minted by an outsider gets 404, not 403 — existence stays hidden', async () => {
    const admin = await persona(true);
    const outsider = await persona(false);
    const id = await seedDoc(admin);

    expect((await v1(outsider.read, `/docs/${id}`)).status).toBe(404);
    // Even a write token: the ACL answers before anything else can.
    expect(
      (
        await v1(outsider.write, `/docs/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: 'x' }),
        })
      ).status,
    ).toBe(404);
  });

  it('an editor can write but cannot administer', async () => {
    const admin = await persona(true);
    const editor = await persona(false);
    const id = await seedDoc(admin);
    await v1(admin.write, `/docs/${id}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({ email: editor.email, role: 'editor' }),
    });

    expect(
      (
        await v1(editor.write, `/docs/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: 'editor renamed it' }),
        })
      ).status,
    ).toBe(200);

    // Delete, archive and collaborator management are owner-or-admin only.
    expect((await v1(editor.write, `/docs/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await v1(editor.write, `/docs/${id}/archive`, { method: 'POST' })).status).toBe(403);
  });
});

describe('/api/v1/docs — listing', () => {
  it("returns owned and shared documents, and hides other people's", async () => {
    const admin = await persona(true);
    const alice = await persona(false);
    const bob = await persona(false);
    const shared = await seedDoc(admin, 'shared-with-alice');
    const secret = await seedDoc(admin, 'bob-never-sees-this');

    await v1(admin.write, `/docs/${shared}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({ email: alice.email, role: 'viewer' }),
    });

    const aliceIds = (
      await json<{ docs: Array<{ id: string }> }>(await v1(alice.read, '/docs'))
    ).docs.map((d) => d.id);
    expect(aliceIds).toContain(shared);
    expect(aliceIds).not.toContain(secret);

    const bobIds = (
      await json<{ docs: Array<{ id: string }> }>(await v1(bob.read, '/docs'))
    ).docs.map((d) => d.id);
    expect(bobIds).not.toContain(shared);
    expect(bobIds).not.toContain(secret);
  });

  it('filters by status', async () => {
    const admin = await persona(true);
    const id = await seedDoc(admin, 'to-archive');
    await v1(admin.write, `/docs/${id}/archive`, { method: 'POST' });

    const inActive = (
      await json<{ docs: Array<{ id: string }> }>(await v1(admin.read, '/docs?status=active'))
    ).docs.map((d) => d.id);
    expect(inActive).not.toContain(id);

    const inArchived = (
      await json<{ docs: Array<{ id: string }> }>(await v1(admin.read, '/docs?status=archived'))
    ).docs.map((d) => d.id);
    expect(inArchived).toContain(id);

    const inAll = (
      await json<{ docs: Array<{ id: string }> }>(await v1(admin.read, '/docs?status=all'))
    ).docs.map((d) => d.id);
    expect(inAll).toContain(id);
  });
});

describe('/api/v1/docs — collaborators', () => {
  it('lists, adds and removes', async () => {
    const admin = await persona(true);
    const mate = await persona(false);
    const id = await seedDoc(admin);

    expect(
      (await json<{ collaborators: unknown[] }>(await v1(admin.read, `/docs/${id}/collaborators`)))
        .collaborators,
    ).toEqual([]);

    const added = await json<{ user_id: string; role: string }>(
      await v1(admin.write, `/docs/${id}/collaborators`, {
        method: 'POST',
        body: JSON.stringify({ email: mate.email, role: 'editor' }),
      }),
    );
    expect(added).toMatchObject({ user_id: mate.userId, role: 'editor' });

    const listed = await json<{ collaborators: Array<Record<string, unknown>> }>(
      await v1(admin.read, `/docs/${id}/collaborators`),
    );
    expect(listed.collaborators).toEqual([
      expect.objectContaining({ user_id: mate.userId, email: mate.email, role: 'editor' }),
    ]);

    expect(
      (await v1(admin.write, `/docs/${id}/collaborators/${mate.userId}`, { method: 'DELETE' }))
        .status,
    ).toBe(204);
    // Second removal is a 404 — the row is gone, not idempotently absent.
    expect(
      (await v1(admin.write, `/docs/${id}/collaborators/${mate.userId}`, { method: 'DELETE' }))
        .status,
    ).toBe(404);
  });

  it('409s an unknown email and a duplicate', async () => {
    const admin = await persona(true);
    const mate = await persona(false);
    const id = await seedDoc(admin);

    const unknown = await v1(admin.write, `/docs/${id}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com', role: 'viewer' }),
    });
    expect(unknown.status).toBe(409);
    expect((await json<{ error: string }>(unknown)).error).toBe('user_not_found');

    await v1(admin.write, `/docs/${id}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({ email: mate.email, role: 'viewer' }),
    });
    const dup = await v1(admin.write, `/docs/${id}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({ email: mate.email, role: 'editor' }),
    });
    expect(dup.status).toBe(409);
    expect((await json<{ error: string }>(dup)).error).toBe('already_collaborator');
  });
});

describe('/api/v1/docs — attribution', () => {
  // The reason v1 reuses the same services rather than getting its own audit
  // vocabulary: one query answers "what did automation do".
  it('stamps token-driven changes as via=api_token, with the token id', async () => {
    const admin = await persona(true);
    const id = await seedDoc(admin, 'audited-by-token');

    const rows = await fx.db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));
    const create = rows.find((r) => r.action === 'doc.create');
    expect(create).toBeDefined();
    expect(create!.actorEmail).toBe(admin.email);
    expect(create!.metadata).toMatchObject({ via: 'api_token' });
    expect((create!.metadata as { token_id?: string }).token_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does NOT stamp via on a browser-plane change', async () => {
    const admin = await persona(true);
    const res = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ title: 'from the UI', engine: 'latex' }),
    });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);

    const [row] = await fx.db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));
    expect(row.metadata).not.toHaveProperty('via');
    // and the doc really is there, via the other plane
    const [doc] = await fx.db.select().from(docs).where(eq(docs.id, id));
    expect(doc.title).toBe('from the UI');
  });
});
