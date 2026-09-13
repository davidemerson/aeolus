import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { docCollaborators, docFiles, docs, users, db as makeDb, type Database } from '@aeolus/db';
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
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'archive-test-secret',
    mail: new MemoryMailAdapter(),
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
  if (res.status !== 201) throw new Error(`dev session ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

interface Seeds {
  aliceId: string;
  bobId: string; // editor on the doc
  carolId: string; // viewer on the doc
  daveId: string; // outsider
  rootId: string; // admin
  docId: string;
}

async function seed(fx: Fixtures): Promise<Seeds> {
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
  const aliceId = await mk('alice', false);
  const bobId = await mk('bob', false);
  const carolId = await mk('carol', false);
  const daveId = await mk('dave', false);
  const rootId = await mk('root', true);
  const [doc] = await fx.db
    .insert(docs)
    .values({ title: 'Archive Test', engine: 'latex', ownerId: aliceId })
    .returning({ id: docs.id });
  await fx.db.insert(docCollaborators).values([
    { docId: doc.id, userId: bobId, role: 'editor' },
    { docId: doc.id, userId: carolId, role: 'viewer' },
  ]);
  return { aliceId, bobId, carolId, daveId, rootId, docId: doc.id };
}

async function call(
  fx: Fixtures,
  userId: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (userId) headers.cookie = await createSessionCookie(fx.baseUrl, userId);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${fx.baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('docs archive', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('owner archives → archived_at set; idempotent unarchive clears it', async () => {
    const s = await seed(fx);

    const arch1 = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`);
    expect(arch1.status).toBe(200);
    const body1 = (await arch1.json()) as {
      doc: { archived_at: string | null };
    };
    expect(body1.doc.archived_at).not.toBeNull();

    // Re-archive is a no-op-friendly 200 with the same row.
    const arch2 = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`);
    expect(arch2.status).toBe(200);

    const un = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/unarchive`);
    expect(un.status).toBe(200);
    const body2 = (await un.json()) as {
      doc: { archived_at: string | null };
    };
    expect(body2.doc.archived_at).toBeNull();

    // Re-unarchive is also idempotent.
    const un2 = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/unarchive`);
    expect(un2.status).toBe(200);
  });

  it('admin can archive any doc; editor cannot; viewer cannot; outsider gets 404', async () => {
    const s = await seed(fx);
    const editor = await call(fx, s.bobId, 'POST', `/docs/${s.docId}/archive`);
    expect(editor.status).toBe(403);
    const viewer = await call(fx, s.carolId, 'POST', `/docs/${s.docId}/archive`);
    expect(viewer.status).toBe(403);
    const outsider = await call(fx, s.daveId, 'POST', `/docs/${s.docId}/archive`);
    expect(outsider.status).toBe(404);
    const admin = await call(fx, s.rootId, 'POST', `/docs/${s.docId}/archive`);
    expect(admin.status).toBe(200);
  });

  it('archive blocks PATCH, asset upload, file create, checkpoint create with 422 archived', async () => {
    const s = await seed(fx);
    const arch = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`);
    expect(arch.status).toBe(200);

    const rename = await call(fx, s.aliceId, 'PATCH', `/docs/${s.docId}`, {
      title: 'Renamed while archived',
    });
    expect(rename.status).toBe(422);
    expect((await rename.json()) as { error: string }).toMatchObject({
      error: 'archived',
    });

    const fileCreate = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/files`, {
      path: 'extra.tex',
    });
    expect(fileCreate.status).toBe(422);

    const checkpointCreate = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, {
      label: 'while archived',
    });
    expect(checkpointCreate.status).toBe(422);

    // Editor (bob) hits the same wall — even though they have write
    // role in principle, archive is a doc-level lock.
    const bobRename = await call(fx, s.bobId, 'PATCH', `/docs/${s.docId}`, {
      title: 'b',
    });
    expect(bobRename.status).toBe(422);

    // Admin too.
    const adminRename = await call(fx, s.rootId, 'PATCH', `/docs/${s.docId}`, {
      title: 'admin override',
    });
    expect(adminRename.status).toBe(422);
  });

  // Issue #48: every other mutation route also needs an explicit
  // 422 archived response. The previous test covered PATCH /docs/:id,
  // POST /docs/:id/files, and POST /docs/:id/checkpoints; this fills
  // in the remaining surface — file rename/delete/upload, project-
  // checkpoint create/restore/delete, and asset upload/delete.
  it('archive blocks the remaining mutation surface with 422 archived', async () => {
    const s = await seed(fx);

    // Seed a text file and a project checkpoint via the API while
    // the doc is still writable, then a blob asset row directly so
    // we don't have to drive multipart through fetch.
    const fileRes = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/files`, {
      path: 'extra.tex',
    });
    expect(fileRes.status).toBe(201);
    const fileId = ((await fileRes.json()) as { file: { id: string } }).file.id;

    const projCpRes = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/project-checkpoints`, {
      label: 'pre-archive',
    });
    expect(projCpRes.status).toBe(201);
    const projCpId = ((await projCpRes.json()) as { project_checkpoint: { id: string } })
      .project_checkpoint.id;

    const [asset] = await fx.db
      .insert(docFiles)
      .values({
        docId: s.docId,
        path: 'logo.png',
        kind: 'blob',
        storageKey: 'assets/logo.png',
        filename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 100,
      })
      .returning({ id: docFiles.id });
    const assetId = asset.id;

    expect((await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`)).status).toBe(200);

    interface Case {
      label: string;
      method: string;
      path: string;
      body?: unknown;
    }
    const cases: Case[] = [
      { label: 'POST /files/upload', method: 'POST', path: `/docs/${s.docId}/files/upload` },
      {
        label: 'PATCH /files/:fileId',
        method: 'PATCH',
        path: `/docs/${s.docId}/files/${fileId}`,
        body: { path: 'renamed.tex' },
      },
      {
        label: 'DELETE /files/:fileId',
        method: 'DELETE',
        path: `/docs/${s.docId}/files/${fileId}`,
      },
      {
        label: 'POST /project-checkpoints',
        method: 'POST',
        path: `/docs/${s.docId}/project-checkpoints`,
        body: { label: 'while archived' },
      },
      {
        label: 'POST /project-checkpoints/:cpId/restore',
        method: 'POST',
        path: `/docs/${s.docId}/project-checkpoints/${projCpId}/restore`,
      },
      {
        label: 'DELETE /project-checkpoints/:cpId',
        method: 'DELETE',
        path: `/docs/${s.docId}/project-checkpoints/${projCpId}`,
      },
      { label: 'POST /assets', method: 'POST', path: `/docs/${s.docId}/assets` },
      {
        label: 'DELETE /assets/:assetId',
        method: 'DELETE',
        path: `/docs/${s.docId}/assets/${assetId}`,
      },
    ];

    for (const c of cases) {
      const res = await call(fx, s.aliceId, c.method, c.path, c.body);
      expect(res.status, c.label).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body, c.label).toMatchObject({ error: 'archived' });
    }
  });

  it('archive does not block reads — GET, list, compile-status, history-list still work', async () => {
    const s = await seed(fx);
    await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`);

    const get = await call(fx, s.bobId, 'GET', `/docs/${s.docId}`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      doc: { archived_at: string | null };
    };
    expect(body.doc.archived_at).not.toBeNull();

    const files = await call(fx, s.bobId, 'GET', `/docs/${s.docId}/files`);
    expect(files.status).toBe(200);

    const checkpoints = await call(fx, s.bobId, 'GET', `/docs/${s.docId}/checkpoints`);
    expect(checkpoints.status).toBe(200);
  });

  it('GET /docs filters by status — default hides archived; ?status=archived shows only archived; ?status=all shows both', async () => {
    const s = await seed(fx);
    // Make a second doc so the assertions are unambiguous after
    // archiving the first one. POST /docs is admin-only (issue #39),
    // so seed via direct DB insert + a doc_files row to mirror the
    // shape POST /docs would have produced.
    const [sibling] = await fx.db
      .insert(docs)
      .values({ title: 'Active sibling', engine: 'latex', ownerId: s.aliceId })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: sibling.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: sibling.id,
    });

    await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`);

    const active = await call(fx, s.aliceId, 'GET', '/docs');
    const activeBody = (await active.json()) as {
      docs: Array<{ id: string; archived_at: string | null }>;
    };
    expect(activeBody.docs.find((d) => d.id === s.docId)).toBeUndefined();

    const archivedOnly = await call(fx, s.aliceId, 'GET', '/docs?status=archived');
    const archivedBody = (await archivedOnly.json()) as {
      docs: Array<{ id: string; archived_at: string | null }>;
    };
    expect(archivedBody.docs).toHaveLength(1);
    expect(archivedBody.docs[0].id).toBe(s.docId);
    expect(archivedBody.docs[0].archived_at).not.toBeNull();

    const all = await call(fx, s.aliceId, 'GET', '/docs?status=all');
    const allBody = (await all.json()) as {
      docs: Array<{ id: string }>;
    };
    expect(allBody.docs.map((d) => d.id)).toContain(s.docId);
    expect(allBody.docs.length).toBeGreaterThanOrEqual(2);
  });

  it('emits doc.archive and doc.unarchive audit events', async () => {
    const s = await seed(fx);
    await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`);
    await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/unarchive`);

    const list = await call(fx, s.rootId, 'GET', '/admin/audit-events?action=doc.');
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      events: Array<{ action: string; resource_id: string }>;
    };
    const forDoc = body.events.filter((e) => e.resource_id === s.docId);
    expect(forDoc.find((e) => e.action === 'doc.archive')).toBeTruthy();
    expect(forDoc.find((e) => e.action === 'doc.unarchive')).toBeTruthy();
  });
});
