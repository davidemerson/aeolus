// Cross-cutting ACL deny tests covering routes the per-feature
// integration tests skipped — viewer 403 / outsider 404 on every
// mutation surface a non-admin can reach. Pulled into one file so
// the same fixture (one doc with owner / editor / viewer / outsider)
// can be reused across endpoints. See issue #44.

import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { docCollaborators, docFiles, docs, users, db as makeDb, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: MemoryBlobStore;
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
  const blobs = new MemoryBlobStore();
  const app = await buildServer({
    db,
    blobs,
    cookieSecret: 'route-acl-test-secret',
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
    blobs,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function cookieFor(baseUrl: string, userId: string): Promise<string> {
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

interface Personas {
  ownerId: string;
  editorId: string;
  viewerId: string;
  outsiderId: string;
  rootId: string;
  docId: string;
  fileId: string;
}

async function seedPersonas(fx: Fixtures): Promise<Personas> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const mk = async (label: string, isAdmin: boolean): Promise<string> => {
    const [row] = await fx.db
      .insert(users)
      .values({
        email: `${label}-${suffix}@example.com`,
        name: label,
        isAdmin,
      })
      .returning({ id: users.id });
    return row.id;
  };
  const ownerId = await mk('owner', false);
  const editorId = await mk('editor', false);
  const viewerId = await mk('viewer', false);
  const outsiderId = await mk('outsider', false);
  const rootId = await mk('admin', true);

  const [doc] = await fx.db
    .insert(docs)
    .values({ title: 'ACL test doc', engine: 'latex', ownerId })
    .returning({ id: docs.id });
  const [mainFile] = await fx.db
    .insert(docFiles)
    .values({ docId: doc.id, path: 'main.tex', kind: 'text', yjsDocId: doc.id })
    .returning({ id: docFiles.id });

  await fx.db.insert(docCollaborators).values([
    { docId: doc.id, userId: editorId, role: 'editor' },
    { docId: doc.id, userId: viewerId, role: 'viewer' },
  ]);

  return {
    ownerId,
    editorId,
    viewerId,
    outsiderId,
    rootId,
    docId: doc.id,
    fileId: mainFile.id,
  };
}

async function call(
  fx: Fixtures,
  userId: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (userId) headers.cookie = await cookieFor(fx.baseUrl, userId);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${fx.baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Mint a `/api/v1` token as a given user, so the same personas can be driven
 * through the machine plane.
 */
async function tokenFor(fx: Fixtures, userId: string, scope: 'read' | 'write'): Promise<string> {
  const cookie = await cookieFor(fx.baseUrl, userId);
  const res = await fetch(`${fx.baseUrl}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `acl-${scope}-${Math.random()}`, scope }),
  });
  if (res.status !== 201) throw new Error(`mint ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function callV1(
  fx: Fixtures,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${fx.baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('route-level ACL gaps (#44)', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('PATCH /docs/:id/files/:fileId rejects viewer with 403, outsider with 404', async () => {
    const p = await seedPersonas(fx);
    // Make a sibling file the viewer / outsider could try to rename
    // (main is rename-locked anyway; this also tests the viewer
    // gate before the lock kicks in).
    const create = await call(fx, p.ownerId, 'POST', `/docs/${p.docId}/files`, {
      path: 'extra.tex',
    });
    expect(create.status).toBe(201);
    const { file } = (await create.json()) as { file: { id: string } };

    const viewer = await call(fx, p.viewerId, 'PATCH', `/docs/${p.docId}/files/${file.id}`, {
      path: 'renamed.tex',
    });
    expect(viewer.status).toBe(403);

    const outsider = await call(fx, p.outsiderId, 'PATCH', `/docs/${p.docId}/files/${file.id}`, {
      path: 'renamed.tex',
    });
    expect(outsider.status).toBe(404);
  });

  it('DELETE /docs/:id/files/:fileId rejects viewer with 403, outsider with 404', async () => {
    const p = await seedPersonas(fx);
    const create = await call(fx, p.ownerId, 'POST', `/docs/${p.docId}/files`, {
      path: 'gone.tex',
    });
    expect(create.status).toBe(201);
    const { file } = (await create.json()) as { file: { id: string } };

    const viewer = await call(fx, p.viewerId, 'DELETE', `/docs/${p.docId}/files/${file.id}`);
    expect(viewer.status).toBe(403);
    const outsider = await call(fx, p.outsiderId, 'DELETE', `/docs/${p.docId}/files/${file.id}`);
    expect(outsider.status).toBe(404);
  });

  it('POST /docs/:id/checkpoints rejects viewer with 403, outsider with 404', async () => {
    const p = await seedPersonas(fx);
    const viewer = await call(fx, p.viewerId, 'POST', `/docs/${p.docId}/checkpoints`, {
      label: 'viewer cp',
    });
    expect(viewer.status).toBe(403);
    const outsider = await call(fx, p.outsiderId, 'POST', `/docs/${p.docId}/checkpoints`, {
      label: 'outsider cp',
    });
    expect(outsider.status).toBe(404);
  });

  it('POST /docs/:id/project-checkpoints rejects viewer with 403, outsider with 404', async () => {
    const p = await seedPersonas(fx);
    const viewer = await call(fx, p.viewerId, 'POST', `/docs/${p.docId}/project-checkpoints`, {
      label: 'viewer pc',
    });
    expect(viewer.status).toBe(403);
    const outsider = await call(fx, p.outsiderId, 'POST', `/docs/${p.docId}/project-checkpoints`, {
      label: 'outsider pc',
    });
    expect(outsider.status).toBe(404);
  });

  it('DELETE /docs/:id/assets/:assetId rejects viewer with 403, outsider with 404', async () => {
    const p = await seedPersonas(fx);
    // Stage a blob asset directly via the schema.
    const storageKey = `assets/${p.docId}/test.png`;
    await fx.blobs.put(storageKey, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const [asset] = await fx.db
      .insert(docFiles)
      .values({
        docId: p.docId,
        path: 'logo.png',
        kind: 'blob',
        storageKey,
        filename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 4,
      })
      .returning({ id: docFiles.id });

    const viewer = await call(fx, p.viewerId, 'DELETE', `/docs/${p.docId}/assets/${asset.id}`);
    expect(viewer.status).toBe(403);
    const outsider = await call(fx, p.outsiderId, 'DELETE', `/docs/${p.docId}/assets/${asset.id}`);
    expect(outsider.status).toBe(404);
  });

  it('admin endpoints reject non-admin users with 403', async () => {
    const p = await seedPersonas(fx);
    // /admin/users — list. Non-admin → 403.
    const list = await call(fx, p.ownerId, 'GET', '/admin/users');
    expect(list.status).toBe(403);
    // /admin/users/:id PATCH. Non-admin → 403.
    const patch = await call(fx, p.ownerId, 'PATCH', `/admin/users/${p.editorId}`, {
      name: 'Promoted',
    });
    expect(patch.status).toBe(403);
    // /admin/audit-events — list. Non-admin → 403.
    const audit = await call(fx, p.ownerId, 'GET', '/admin/audit-events');
    expect(audit.status).toBe(403);
  });
});

/**
 * The same ACL questions, asked of BOTH planes, side by side.
 *
 * The value of putting this here rather than in a v1-only file is that a
 * divergence fails one file with both answers visible. The two planes share a
 * service layer precisely so they cannot drift — this is what proves it, and
 * what will fail if someone ever "just adds" a v1 route that reimplements the
 * ACL instead of calling the service.
 */
describe('/api/v1 answers the ACL identically to the browser plane', () => {
  let fx: Fixtures;
  let p: Personas;

  beforeAll(async () => {
    fx = await setup();
    p = await seedPersonas(fx);
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  interface Case {
    label: string;
    method: string;
    path: (p: Personas) => string;
    body?: unknown;
    /** For a body that has to name a persona's document. */
    bodyFor?: (p: Personas) => unknown;
    persona: (p: Personas) => string;
    expected: number;
  }

  const cases: Case[] = [
    {
      label: 'owner reads',
      method: 'GET',
      path: (p) => `/docs/${p.docId}`,
      persona: (p) => p.ownerId,
      expected: 200,
    },
    {
      label: 'editor reads',
      method: 'GET',
      path: (p) => `/docs/${p.docId}`,
      persona: (p) => p.editorId,
      expected: 200,
    },
    {
      label: 'viewer reads',
      method: 'GET',
      path: (p) => `/docs/${p.docId}`,
      persona: (p) => p.viewerId,
      expected: 200,
    },
    {
      label: 'outsider reads',
      method: 'GET',
      path: (p) => `/docs/${p.docId}`,
      persona: (p) => p.outsiderId,
      expected: 404,
    },
    {
      label: 'admin reads',
      method: 'GET',
      path: (p) => `/docs/${p.docId}`,
      persona: (p) => p.rootId,
      expected: 200,
    },

    {
      label: 'editor renames',
      method: 'PATCH',
      path: (p) => `/docs/${p.docId}`,
      body: { title: 'x' },
      persona: (p) => p.editorId,
      expected: 200,
    },
    {
      label: 'viewer renames',
      method: 'PATCH',
      path: (p) => `/docs/${p.docId}`,
      body: { title: 'x' },
      persona: (p) => p.viewerId,
      expected: 403,
    },
    {
      label: 'outsider renames',
      method: 'PATCH',
      path: (p) => `/docs/${p.docId}`,
      body: { title: 'x' },
      persona: (p) => p.outsiderId,
      expected: 404,
    },

    {
      label: 'editor archives',
      method: 'POST',
      path: (p) => `/docs/${p.docId}/archive`,
      persona: (p) => p.editorId,
      expected: 403,
    },
    {
      label: 'viewer archives',
      method: 'POST',
      path: (p) => `/docs/${p.docId}/archive`,
      persona: (p) => p.viewerId,
      expected: 403,
    },
    {
      label: 'outsider archives',
      method: 'POST',
      path: (p) => `/docs/${p.docId}/archive`,
      persona: (p) => p.outsiderId,
      expected: 404,
    },

    {
      label: 'editor adds a collaborator',
      method: 'POST',
      path: (p) => `/docs/${p.docId}/collaborators`,
      body: { email: 'nobody@example.com', role: 'viewer' },
      persona: (p) => p.editorId,
      expected: 403,
    },
    {
      label: 'outsider adds a collaborator',
      method: 'POST',
      path: (p) => `/docs/${p.docId}/collaborators`,
      body: { email: 'nobody@example.com', role: 'viewer' },
      persona: (p) => p.outsiderId,
      expected: 404,
    },

    // The collaboration ticket. Both planes take `doc_id`, so it drops straight
    // into the comparison — and it is the route where a divergence would matter
    // most, because a ticket is redeemed somewhere neither plane can police.
    {
      label: 'viewer mints a ws ticket',
      method: 'POST',
      path: () => '/ws/ticket',
      body: undefined,
      persona: (p) => p.viewerId,
      expected: 201,
      bodyFor: (p) => ({ doc_id: p.docId }),
    },
    {
      label: 'outsider mints a ws ticket',
      method: 'POST',
      path: () => '/ws/ticket',
      persona: (p) => p.outsiderId,
      expected: 404,
      bodyFor: (p) => ({ doc_id: p.docId }),
    },

    {
      label: 'editor deletes',
      method: 'DELETE',
      path: (p) => `/docs/${p.docId}`,
      persona: (p) => p.editorId,
      expected: 403,
    },
    {
      label: 'outsider deletes',
      method: 'DELETE',
      path: (p) => `/docs/${p.docId}`,
      persona: (p) => p.outsiderId,
      expected: 404,
    },
  ];

  it.each(cases)('$label — same status on both planes', async (c) => {
    const userId = c.persona(p);
    const path = c.path(p);

    const body = c.bodyFor ? c.bodyFor(p) : c.body;

    const browser = await call(fx, userId, c.method, path, body);
    // A write-scope token, so the SCOPE gate never fires and what is being
    // compared is purely the document ACL.
    const machine = await callV1(fx, await tokenFor(fx, userId, 'write'), c.method, path, body);

    expect(
      { plane: 'v1', status: machine.status },
      `browser=${browser.status} v1=${machine.status}`,
    ).toEqual({ plane: 'v1', status: browser.status });
    expect(browser.status).toBe(c.expected);
  });

  it('an unauthenticated caller is refused on both planes', async () => {
    const path = `/docs/${p.docId}`;
    expect((await call(fx, null, 'GET', path)).status).toBe(401);
    expect((await callV1(fx, null, 'GET', path)).status).toBe(401);
  });
});
