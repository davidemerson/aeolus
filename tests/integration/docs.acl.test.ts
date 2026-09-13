import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { docCollaborators, docs, users, db as makeDb, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

const PUBLIC_BASE_URL = 'http://localhost:5173';

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
  const mail = new MemoryMailAdapter();
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'integration-test-secret-do-not-use',
    mail,
    publicBaseUrl: PUBLIC_BASE_URL,
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

async function createSessionCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) {
    throw new Error(`Failed to create dev session: ${res.status}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No set-cookie returned from /dev/sessions');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('Failed to parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

interface Persona {
  id: string;
  email: string;
}

interface AclFixture {
  alice: Persona;
  bob: Persona;
  carol: Persona;
  dave: Persona;
  root: Persona;
  docId: string;
}

async function insertUser(
  db: Database,
  opts: { email: string; name: string; isAdmin: boolean },
): Promise<{ id: string; email: string }> {
  const [row] = await db
    .insert(users)
    .values({ email: opts.email, name: opts.name, isAdmin: opts.isAdmin })
    .returning({ id: users.id, email: users.email });
  return row;
}

async function seedAclFixture(fx: Fixtures): Promise<AclFixture> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const mkUser = async (label: string, isAdmin: boolean): Promise<Persona> => {
    const row = await insertUser(fx.db, {
      email: `${label}-${suffix}@example.com`,
      name: label,
      isAdmin,
    });
    return { id: row.id, email: row.email };
  };

  const alice = await mkUser('alice', false);
  const bob = await mkUser('bob', false);
  const carol = await mkUser('carol', false);
  const dave = await mkUser('dave', false);
  const root = await mkUser('root', true);

  const [doc] = await fx.db
    .insert(docs)
    .values({ title: 'Alice draft', engine: 'latex', ownerId: alice.id })
    .returning({ id: docs.id });

  await fx.db.insert(docCollaborators).values([
    { docId: doc.id, userId: bob.id, role: 'editor' },
    { docId: doc.id, userId: carol.id, role: 'viewer' },
  ]);

  return { alice, bob, carol, dave, root, docId: doc.id };
}

async function req(
  baseUrl: string,
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function as(
  fx: Fixtures,
  persona: Persona,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const cookie = await createSessionCookie(fx.baseUrl, persona.id);
  return req(fx.baseUrl, method, path, cookie, body);
}

describe('docs ACL', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  describe('POST /docs', () => {
    it('admin creates a doc owned by themselves (201)', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.root, 'POST', '/docs', {
        title: 'Fresh',
        engine: 'typst',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(typeof body.id).toBe('string');
      const row = await fx.dbPool.query<{ owner_id: string }>(
        'SELECT owner_id FROM docs WHERE id = $1',
        [body.id],
      );
      expect(row.rows[0]?.owner_id).toBe(f.root.id);
    });

    it('non-admin POST /docs returns 403 — end users must fork a template instead', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.alice, 'POST', '/docs', {
        title: 'No bare-doc creation for you',
        engine: 'latex',
      });
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated requests (401)', async () => {
      const res = await req(fx.baseUrl, 'POST', '/docs', undefined, {
        title: 'No cookie',
        engine: 'latex',
      });
      expect(res.status).toBe(401);
    });

    it('admin rejects invalid body (400)', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.root, 'POST', '/docs', { title: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /docs', () => {
    it('scopes list to owned + collaborating docs', async () => {
      const f = await seedAclFixture(fx);

      const aliceRes = await as(fx, f.alice, 'GET', '/docs');
      expect(aliceRes.status).toBe(200);
      const aliceBody = (await aliceRes.json()) as { docs: { id: string }[] };
      expect(aliceBody.docs.some((d) => d.id === f.docId)).toBe(true);

      const bobRes = await as(fx, f.bob, 'GET', '/docs');
      const bobBody = (await bobRes.json()) as { docs: { id: string }[] };
      expect(bobBody.docs.some((d) => d.id === f.docId)).toBe(true);

      const carolRes = await as(fx, f.carol, 'GET', '/docs');
      const carolBody = (await carolRes.json()) as { docs: { id: string }[] };
      expect(carolBody.docs.some((d) => d.id === f.docId)).toBe(true);

      const daveRes = await as(fx, f.dave, 'GET', '/docs');
      const daveBody = (await daveRes.json()) as { docs: { id: string }[] };
      expect(daveBody.docs.some((d) => d.id === f.docId)).toBe(false);

      const rootRes = await as(fx, f.root, 'GET', '/docs');
      const rootBody = (await rootRes.json()) as { docs: { id: string }[] };
      expect(rootBody.docs.some((d) => d.id === f.docId)).toBe(true);
    });

    it('hides soft-deleted docs from non-admins and admins without flag; shows to admin with ?includeDeleted=true', async () => {
      const f = await seedAclFixture(fx);

      const del = await as(fx, f.alice, 'DELETE', `/docs/${f.docId}`);
      expect(del.status).toBe(204);

      for (const persona of [f.alice, f.bob, f.carol]) {
        const res = await as(fx, persona, 'GET', '/docs');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { docs: { id: string }[] };
        expect(body.docs.some((d) => d.id === f.docId)).toBe(false);
      }

      const rootPlain = await as(fx, f.root, 'GET', '/docs');
      const rootPlainBody = (await rootPlain.json()) as { docs: { id: string }[] };
      expect(rootPlainBody.docs.some((d) => d.id === f.docId)).toBe(false);

      const rootAll = await as(fx, f.root, 'GET', '/docs?includeDeleted=true');
      const rootAllBody = (await rootAll.json()) as {
        docs: { id: string; deleted_at: string | null }[];
      };
      const found = rootAllBody.docs.find((d) => d.id === f.docId);
      expect(found).toBeDefined();
      expect(found?.deleted_at).not.toBeNull();
    });

    it('rejects unauthenticated requests (401)', async () => {
      const res = await req(fx.baseUrl, 'GET', '/docs');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /docs/:id', () => {
    it('alice (owner), bob (editor), carol (viewer), root (admin) can read; dave gets 404', async () => {
      const f = await seedAclFixture(fx);
      for (const persona of [f.alice, f.bob, f.carol, f.root]) {
        const res = await as(fx, persona, 'GET', `/docs/${f.docId}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { doc: { id: string; engine: string } };
        expect(body.doc.id).toBe(f.docId);
        expect(body.doc.engine).toBe('latex');
      }
      const daveRes = await as(fx, f.dave, 'GET', `/docs/${f.docId}`);
      expect(daveRes.status).toBe(404);
    });

    it('returns 404 for unknown and malformed doc ids', async () => {
      const f = await seedAclFixture(fx);
      const unknown = await as(fx, f.alice, 'GET', '/docs/00000000-0000-4000-8000-000000000000');
      expect(unknown.status).toBe(404);
      const malformed = await as(fx, f.alice, 'GET', '/docs/not-a-uuid');
      expect(malformed.status).toBe(404);
    });

    it('soft-deleted doc: 404 for alice/bob/carol, 200 for root', async () => {
      const f = await seedAclFixture(fx);
      await as(fx, f.alice, 'DELETE', `/docs/${f.docId}`);

      for (const persona of [f.alice, f.bob, f.carol]) {
        const res = await as(fx, persona, 'GET', `/docs/${f.docId}`);
        expect(res.status).toBe(404);
      }

      const rootRes = await as(fx, f.root, 'GET', `/docs/${f.docId}`);
      expect(rootRes.status).toBe(200);
      const body = (await rootRes.json()) as { doc: { deleted_at: string | null } };
      expect(body.doc.deleted_at).not.toBeNull();
    });
  });

  describe('PATCH /docs/:id', () => {
    it('alice (owner) can update title', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.alice, 'PATCH', `/docs/${f.docId}`, {
        title: 'Updated by Alice',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { doc: { title: string } };
      expect(body.doc.title).toBe('Updated by Alice');
    });

    it('bob (editor) can update title', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.bob, 'PATCH', `/docs/${f.docId}`, {
        title: 'Updated by Bob',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { doc: { title: string } };
      expect(body.doc.title).toBe('Updated by Bob');
    });

    it('carol (viewer) gets 403', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.carol, 'PATCH', `/docs/${f.docId}`, {
        title: 'nope',
      });
      expect(res.status).toBe(403);
    });

    it('dave (non-member) gets 404 (no existence leak)', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.dave, 'PATCH', `/docs/${f.docId}`, {
        title: 'nope',
      });
      expect(res.status).toBe(404);
    });

    it('root (admin) can update title', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.root, 'PATCH', `/docs/${f.docId}`, {
        title: 'Updated by Root',
      });
      expect(res.status).toBe(200);
    });

    it('engine is immutable (extra field ignored, engine unchanged)', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.alice, 'PATCH', `/docs/${f.docId}`, {
        title: 'Change engine?',
        engine: 'typst',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { doc: { engine: string } };
      expect(body.doc.engine).toBe('latex');
    });

    it('soft-deleted doc: 404 for alice/bob/carol, 200 for root', async () => {
      const f = await seedAclFixture(fx);
      await as(fx, f.alice, 'DELETE', `/docs/${f.docId}`);

      for (const persona of [f.alice, f.bob, f.carol]) {
        const res = await as(fx, persona, 'PATCH', `/docs/${f.docId}`, {
          title: 'after delete',
        });
        expect(res.status).toBe(404);
      }

      const rootRes = await as(fx, f.root, 'PATCH', `/docs/${f.docId}`, {
        title: 'admin edit',
      });
      expect(rootRes.status).toBe(200);
    });
  });

  describe('DELETE /docs/:id', () => {
    it('alice (owner) can delete', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.alice, 'DELETE', `/docs/${f.docId}`);
      expect(res.status).toBe(204);
      const row = await fx.dbPool.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM docs WHERE id = $1',
        [f.docId],
      );
      expect(row.rows[0]?.deleted_at).not.toBeNull();
    });

    it('bob (editor) gets 403', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.bob, 'DELETE', `/docs/${f.docId}`);
      expect(res.status).toBe(403);
    });

    it('carol (viewer) gets 403', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.carol, 'DELETE', `/docs/${f.docId}`);
      expect(res.status).toBe(403);
    });

    it('dave (non-member) gets 404', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.dave, 'DELETE', `/docs/${f.docId}`);
      expect(res.status).toBe(404);
    });

    it('root (admin) can delete', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.root, 'DELETE', `/docs/${f.docId}`);
      expect(res.status).toBe(204);
    });
  });

  describe('POST /docs/:id/collaborators', () => {
    it('alice (owner) can add a collaborator for an existing user', async () => {
      const f = await seedAclFixture(fx);
      const target = await insertUser(fx.db, {
        email: `eve-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.com`,
        name: 'Eve',
        isAdmin: false,
      });
      const res = await as(fx, f.alice, 'POST', `/docs/${f.docId}/collaborators`, {
        email: target.email,
        role: 'editor',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { user_id: string; role: string };
      expect(body.user_id).toBe(target.id);
      expect(body.role).toBe('editor');
    });

    it('returns 409 when the email is not a known user', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.alice, 'POST', `/docs/${f.docId}/collaborators`, {
        email: `ghost-${Date.now()}@example.com`,
        role: 'viewer',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('user_not_found');
    });

    it('bob (editor) gets 403', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.bob, 'POST', `/docs/${f.docId}/collaborators`, {
        email: f.dave.email,
        role: 'viewer',
      });
      expect(res.status).toBe(403);
    });

    it('carol (viewer) gets 403', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.carol, 'POST', `/docs/${f.docId}/collaborators`, {
        email: f.dave.email,
        role: 'viewer',
      });
      expect(res.status).toBe(403);
    });

    it('dave (non-member) gets 404', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.dave, 'POST', `/docs/${f.docId}/collaborators`, {
        email: f.dave.email,
        role: 'viewer',
      });
      expect(res.status).toBe(404);
    });

    it('root (admin) can add a collaborator', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.root, 'POST', `/docs/${f.docId}/collaborators`, {
        email: f.dave.email,
        role: 'viewer',
      });
      expect(res.status).toBe(201);
    });

    it('409 when the user is already a collaborator', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.alice, 'POST', `/docs/${f.docId}/collaborators`, {
        email: f.bob.email,
        role: 'editor',
      });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /docs/:id/collaborators/:userId', () => {
    it('alice (owner) can remove a collaborator', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.alice, 'DELETE', `/docs/${f.docId}/collaborators/${f.bob.id}`);
      expect(res.status).toBe(204);
    });

    it('bob (editor) gets 403', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.bob, 'DELETE', `/docs/${f.docId}/collaborators/${f.carol.id}`);
      expect(res.status).toBe(403);
    });

    it('carol (viewer) gets 403', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.carol, 'DELETE', `/docs/${f.docId}/collaborators/${f.bob.id}`);
      expect(res.status).toBe(403);
    });

    it('dave (non-member) gets 404', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.dave, 'DELETE', `/docs/${f.docId}/collaborators/${f.bob.id}`);
      expect(res.status).toBe(404);
    });

    it('root (admin) can remove a collaborator', async () => {
      const f = await seedAclFixture(fx);
      const res = await as(fx, f.root, 'DELETE', `/docs/${f.docId}/collaborators/${f.carol.id}`);
      expect(res.status).toBe(204);
    });
  });
});
