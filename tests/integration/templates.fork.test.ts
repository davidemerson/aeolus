import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { createWsServer, type WsServerHandle } from '@aeolus/ws';

import { parseSetCookie } from './helpers/cookies.js';
import { waitFor } from './helpers/poll.js';
import { connectYjsClient } from './helpers/yjs-client.js';

const COOKIE_SECRET = 'integration-test-secret-do-not-use';
const TEMPLATE_SOURCE = '\\documentclass{article}\n\\begin{document}Hello\\end{document}';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: MemoryBlobStore;
  ws: WsServerHandle;
  wsUrlBase: string;
  apiBaseUrl: string;
  close(): Promise<void>;
}

// Rows the ws server has persisted for a Yjs doc so far. The persist is
// asynchronous and unacknowledged, so tests poll this (helpers/poll.ts).
async function countUpdates(fx: Fixtures, yjsDocId: string): Promise<number> {
  const { rows } = await fx.dbPool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM doc_updates WHERE yjs_doc_id = $1',
    [yjsDocId],
  );
  return Number(rows[0]?.count ?? '0');
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
    cookieSecret: COOKIE_SECRET,
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiAddress = app.server.address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${apiAddress.port}`;

  const ws = createWsServer({
    db,
    dbPool: pool,
    blobs,
    cookieSecret: COOKIE_SECRET,
    snapshotUpdateThreshold: 4,
    snapshotIdleMs: 60_000,
  });
  const { host, port } = await ws.listen(0, '127.0.0.1');
  const wsUrlBase = `ws://${host}:${port}`;

  return {
    postgres,
    db,
    dbPool: pool,
    blobs,
    ws,
    wsUrlBase,
    apiBaseUrl,
    async close() {
      await ws.close();
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function freshCookie(baseUrl: string, userId: string): Promise<string> {
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

async function as(
  baseUrl: string,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const cookie = await freshCookie(baseUrl, userId);
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface TemplateJson {
  id: string;
  name: string;
  is_published: boolean;
  yjs_doc_id: string;
}

async function seedUser(db: Database, label: string, isAdmin: boolean): Promise<string> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const [row] = await db
    .insert(users)
    .values({
      email: `${label}-${suffix}@example.com`,
      name: label,
      isAdmin,
    })
    .returning({ id: users.id });
  return row.id;
}

describe('templates fork flow', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('round-trips a template into a user-owned doc and isolates further edits', async () => {
    const adminId = await seedUser(fx.db, 'admin', true);
    const userId = await seedUser(fx.db, 'user', false);

    const createRes = await as(fx.apiBaseUrl, adminId, 'POST', '/templates', {
      name: 'Branded LaTeX',
      description: 'Official',
      engine: 'latex',
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { template: TemplateJson };
    const template = createBody.template;
    expect(template.is_published).toBe(false);
    expect(typeof template.yjs_doc_id).toBe('string');

    const adminWsCookie = await freshCookie(fx.apiBaseUrl, adminId);
    const adminWriter = connectYjsClient(
      `${fx.wsUrlBase}/?docId=${template.yjs_doc_id}`,
      adminWsCookie,
    );
    await adminWriter.waitOpen();
    adminWriter.doc.getText('source').insert(0, TEMPLATE_SOURCE);
    // Persist is fire-and-forget on the ws side (#77): wait for the
    // update row before closing, or forceSnapshot below may compact
    // nothing.
    await waitFor(() => countUpdates(fx, template.yjs_doc_id), {
      label: 'template doc_updates persisted',
    });
    await adminWriter.close();

    const snapResult = await fx.ws.forceSnapshot(template.yjs_doc_id);
    expect(snapResult).not.toBeNull();

    const publishRes = await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      isPublished: true,
    });
    expect(publishRes.status).toBe(200);

    const userListRes = await as(fx.apiBaseUrl, userId, 'GET', '/templates');
    expect(userListRes.status).toBe(200);
    const userList = (await userListRes.json()) as { templates: TemplateJson[] };
    expect(userList.templates.some((t) => t.id === template.id)).toBe(true);

    const forkRes = await as(fx.apiBaseUrl, userId, 'POST', `/templates/${template.id}/fork`);
    expect(forkRes.status).toBe(201);
    const forkBody = (await forkRes.json()) as { doc_id: string };
    expect(typeof forkBody.doc_id).toBe('string');
    expect(forkBody.doc_id).not.toBe(template.yjs_doc_id);

    const userWsCookie = await freshCookie(fx.apiBaseUrl, userId);
    const forkReader = connectYjsClient(`${fx.wsUrlBase}/?docId=${forkBody.doc_id}`, userWsCookie);
    await forkReader.waitOpen();
    const forkedText = await forkReader.waitForText((t) => t === TEMPLATE_SOURCE);
    expect(forkedText).toBe(TEMPLATE_SOURCE);

    const forkUpdatesBefore = await countUpdates(fx, forkBody.doc_id);
    forkReader.doc.getText('source').insert(forkedText.length, '\n% forked edit');
    await waitFor(async () => (await countUpdates(fx, forkBody.doc_id)) > forkUpdatesBefore, {
      label: 'fork edit persisted',
    });
    await forkReader.close();

    const adminVerifyCookie = await freshCookie(fx.apiBaseUrl, adminId);
    const adminVerify = connectYjsClient(
      `${fx.wsUrlBase}/?docId=${template.yjs_doc_id}`,
      adminVerifyCookie,
    );
    await adminVerify.waitOpen();
    await new Promise((r) => setTimeout(r, 100));
    const templateText = adminVerify.doc.getText('source').toString();
    expect(templateText).toBe(TEMPLATE_SOURCE);
    await adminVerify.close();

    const userRejectCookie = await freshCookie(fx.apiBaseUrl, userId);
    const unauthorized = new WebSocket(`${fx.wsUrlBase}/?docId=${template.yjs_doc_id}`, {
      headers: { cookie: userRejectCookie },
    });
    const closeCode = await new Promise<number>((resolve, reject) => {
      unauthorized.once('close', (code) => resolve(code));
      unauthorized.once('error', () => {
        /* close event still fires */
      });
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    expect(closeCode).toBe(1008);
  }, 60_000);

  it('non-admins cannot see unpublished templates or fork them', async () => {
    const adminId = await seedUser(fx.db, 'admin2', true);
    const userId = await seedUser(fx.db, 'user2', false);

    const createRes = await as(fx.apiBaseUrl, adminId, 'POST', '/templates', {
      name: 'Draft only',
      engine: 'typst',
    });
    expect(createRes.status).toBe(201);
    const { template } = (await createRes.json()) as { template: TemplateJson };

    const listRes = await as(fx.apiBaseUrl, userId, 'GET', '/templates');
    const listBody = (await listRes.json()) as { templates: TemplateJson[] };
    expect(listBody.templates.some((t) => t.id === template.id)).toBe(false);

    const getRes = await as(fx.apiBaseUrl, userId, 'GET', `/templates/${template.id}`);
    expect(getRes.status).toBe(404);

    const forkRes = await as(fx.apiBaseUrl, userId, 'POST', `/templates/${template.id}/fork`);
    expect(forkRes.status).toBe(404);
  });

  it('honours a caller-supplied title and copies template blob assets to the fork', async () => {
    const { docFiles, docs } = await import('@aeolus/db');
    const { eq, and } = await import('drizzle-orm');

    const adminId = await seedUser(fx.db, 'admin-blob', true);
    const userId = await seedUser(fx.db, 'user-blob', false);

    const createRes = await as(fx.apiBaseUrl, adminId, 'POST', '/templates', {
      name: 'Branded LaTeX',
      engine: 'latex',
    });
    expect(createRes.status).toBe(201);
    const { template } = (await createRes.json()) as { template: TemplateJson };

    // Stage a logo asset directly on the template's backing doc by
    // writing the blob and a doc_files row — same path the
    // /files/upload endpoint takes, but skips needing template-side
    // upload UI.
    const storageKey = `assets/${template.yjs_doc_id}/logo.png`;
    await fx.blobs.put(storageKey, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fx.db.insert(docFiles).values({
      docId: template.yjs_doc_id,
      path: 'logo.png',
      kind: 'blob',
      storageKey,
      filename: 'logo.png',
      mimeType: 'image/png',
      sizeBytes: 4,
    });

    await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      isPublished: true,
    });

    const forkRes = await as(fx.apiBaseUrl, userId, 'POST', `/templates/${template.id}/fork`, {
      title: 'My Custom Doc 1729000000',
    });
    expect(forkRes.status).toBe(201);
    const forkBody = (await forkRes.json()) as {
      doc_id: string;
      title: string;
      blobs_copied: number;
    };
    expect(forkBody.title).toBe('My Custom Doc 1729000000');
    expect(forkBody.blobs_copied).toBe(1);

    // Doc title persisted as supplied.
    const [docRow] = await fx.db
      .select({ title: docs.title })
      .from(docs)
      .where(eq(docs.id, forkBody.doc_id));
    expect(docRow.title).toBe('My Custom Doc 1729000000');

    // Forked doc has a doc_files blob row pointing at the same S3
    // key — sharing bytes is intentional (see comment in
    // routes/templates.ts).
    const blobRows = await fx.db
      .select({
        path: docFiles.path,
        kind: docFiles.kind,
        storageKey: docFiles.storageKey,
        sizeBytes: docFiles.sizeBytes,
      })
      .from(docFiles)
      .where(and(eq(docFiles.docId, forkBody.doc_id), eq(docFiles.kind, 'blob')));
    expect(blobRows).toHaveLength(1);
    expect(blobRows[0].path).toBe('logo.png');
    expect(blobRows[0].storageKey).toBe(storageKey);
    expect(blobRows[0].sizeBytes).toBe(4);
  }, 60_000);

  it('copies every text file in the template — not just main (issue #36)', async () => {
    const { docFiles } = await import('@aeolus/db');
    const { eq, and } = await import('drizzle-orm');
    const { persistUpdate, loadDoc } = await import('@aeolus/crdt');
    const Y = await import('yjs');
    const crypto = await import('node:crypto');

    const adminId = await seedUser(fx.db, 'admin-multitext', true);
    const userId = await seedUser(fx.db, 'user-multitext', false);

    const createRes = await as(fx.apiBaseUrl, adminId, 'POST', '/templates', {
      name: 'Quarterly Report',
      engine: 'latex',
    });
    expect(createRes.status).toBe(201);
    const { template } = (await createRes.json()) as { template: TemplateJson };

    // Plant a sibling text file `report-frontmatter.tex` in the
    // template — fresh yjs_doc_id (UNIQUE per ADR 0013), distinct
    // from the template's main yjs_doc_id. This is exactly the
    // shape the user-facing Files panel produces when an admin
    // creates a second .tex inside the template.
    const frontmatterYjsDocId = crypto.randomUUID();
    await fx.db.insert(docFiles).values({
      docId: template.yjs_doc_id,
      path: 'report-frontmatter.tex',
      kind: 'text',
      yjsDocId: frontmatterYjsDocId,
    });
    // Seed both files with distinguishable content so the fork can
    // verify the copy is correct, not just present.
    const seedYjs = async (yjsDocId: string, body: string): Promise<void> => {
      const doc = new Y.Doc();
      doc.getText('source').insert(0, body);
      const update = Y.encodeStateAsUpdate(doc);
      await persistUpdate({ db: fx.db, blobs: fx.blobs }, yjsDocId, 0n, update, adminId);
      doc.destroy();
    };
    await seedYjs(
      template.yjs_doc_id,
      '\\input{report-frontmatter}\n\\begin{document}body\\end{document}',
    );
    await seedYjs(frontmatterYjsDocId, '\\title{Quarterly Report}\n\\author{Example Org}');

    await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      isPublished: true,
    });

    const forkRes = await as(fx.apiBaseUrl, userId, 'POST', `/templates/${template.id}/fork`);
    expect(forkRes.status).toBe(201);
    const forkBody = (await forkRes.json()) as {
      doc_id: string;
      text_files_copied: number;
    };
    expect(forkBody.text_files_copied).toBe(2);

    // Both text-file rows landed in the new doc, with the same
    // paths the template had.
    const forkedTextRows = await fx.db
      .select({
        path: docFiles.path,
        yjsDocId: docFiles.yjsDocId,
      })
      .from(docFiles)
      .where(and(eq(docFiles.docId, forkBody.doc_id), eq(docFiles.kind, 'text')));
    const paths = forkedTextRows.map((r) => r.path).sort();
    expect(paths).toEqual(['main.tex', 'report-frontmatter.tex']);

    // Each forked text file has its OWN yjs_doc_id, distinct from
    // the template's. The main file follows the legacy convention
    // `yjs_doc_id == docs.id`; the sibling is a freshly-minted UUID.
    const main = forkedTextRows.find((r) => r.path === 'main.tex');
    const front = forkedTextRows.find((r) => r.path === 'report-frontmatter.tex');
    expect(main?.yjsDocId).toBe(forkBody.doc_id);
    expect(front?.yjsDocId).toBeTruthy();
    expect(front?.yjsDocId).not.toBe(template.yjs_doc_id);
    expect(front?.yjsDocId).not.toBe(frontmatterYjsDocId);

    // The forked Yjs source matches the template's at fork time.
    const loadedFront = await loadDoc({ db: fx.db, blobs: fx.blobs }, front!.yjsDocId!);
    expect(loadedFront.doc.getText('source').toString()).toBe(
      '\\title{Quarterly Report}\n\\author{Example Org}',
    );
    loadedFront.doc.destroy();

    const loadedMain = await loadDoc({ db: fx.db, blobs: fx.blobs }, main!.yjsDocId!);
    expect(loadedMain.doc.getText('source').toString()).toBe(
      '\\input{report-frontmatter}\n\\begin{document}body\\end{document}',
    );
    loadedMain.doc.destroy();
  }, 60_000);

  it('falls back to the template name when title is omitted', async () => {
    const adminId = await seedUser(fx.db, 'admin-default', true);
    const userId = await seedUser(fx.db, 'user-default', false);

    const createRes = await as(fx.apiBaseUrl, adminId, 'POST', '/templates', {
      name: 'Default-Name Template',
      engine: 'latex',
    });
    const { template } = (await createRes.json()) as { template: TemplateJson };
    await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      isPublished: true,
    });

    const forkRes = await as(fx.apiBaseUrl, userId, 'POST', `/templates/${template.id}/fork`);
    expect(forkRes.status).toBe(201);
    const body = (await forkRes.json()) as { doc_id: string; title: string };
    expect(body.title).toBe('Default-Name Template');
  });

  it('non-admins cannot create, patch, or delete templates', async () => {
    const adminId = await seedUser(fx.db, 'admin3', true);
    const userId = await seedUser(fx.db, 'user3', false);

    const createRes = await as(fx.apiBaseUrl, userId, 'POST', '/templates', {
      name: 'Nope',
      engine: 'latex',
    });
    expect(createRes.status).toBe(403);

    const adminCreate = await as(fx.apiBaseUrl, adminId, 'POST', '/templates', {
      name: 'AdminT',
      engine: 'latex',
    });
    expect(adminCreate.status).toBe(201);
    const { template } = (await adminCreate.json()) as { template: TemplateJson };

    const patchRes = await as(fx.apiBaseUrl, userId, 'PATCH', `/templates/${template.id}`, {
      isPublished: true,
    });
    expect(patchRes.status).toBe(403);

    const deleteRes = await as(fx.apiBaseUrl, userId, 'DELETE', `/templates/${template.id}`);
    expect(deleteRes.status).toBe(403);
  });

  // Issue #73. Responses serialise the field as `is_published` (like every
  // other field on this wire), but PATCH only accepted `isPublished` — so
  // sending back the object you were just handed failed validation, with an
  // error that named the right spelling only if you read it carefully. Both
  // spellings are accepted now; the response spelling is the documented one.
  it('accepts is_published as well as isPublished on PATCH, and rejects neither-field bodies', async () => {
    const adminId = await seedUser(fx.db, 'admin-casing', true);
    const created = await as(fx.apiBaseUrl, adminId, 'POST', '/templates', {
      name: 'Casing',
      engine: 'typst',
    });
    expect(created.status).toBe(201);
    const { template } = (await created.json()) as { template: TemplateJson };
    expect(template.is_published).toBe(false);

    // The round-trip that used to fail: PATCH the wire spelling back.
    const snake = await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      is_published: true,
    });
    expect(snake.status).toBe(200);
    expect(((await snake.json()) as { template: TemplateJson }).template.is_published).toBe(true);

    // camelCase still works — the web client shipped it for months and any
    // operator script written against the old shape must keep working.
    const camel = await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      isPublished: false,
    });
    expect(camel.status).toBe(200);
    expect(((await camel.json()) as { template: TemplateJson }).template.is_published).toBe(false);

    // snake_case wins when both are sent: it is the wire spelling.
    const both = await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      isPublished: false,
      is_published: true,
    });
    expect(both.status).toBe(200);
    expect(((await both.json()) as { template: TemplateJson }).template.is_published).toBe(true);

    // The refine still rejects a body with none of the three fields — adding
    // an alias must not turn PATCH into a no-op that reports success.
    const empty = await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      nope: true,
    });
    expect(empty.status).toBe(400);

    // A full round-trip of the GET body, which is the actual reported bug:
    // read the template, flip one field on the object you were given, send it
    // straight back.
    const listRes = await as(fx.apiBaseUrl, adminId, 'GET', '/templates');
    const list = (await listRes.json()) as { templates: TemplateJson[] };
    const mine = list.templates.find((t) => t.id === template.id);
    expect(mine).toBeDefined();
    const roundTrip = await as(fx.apiBaseUrl, adminId, 'PATCH', `/templates/${template.id}`, {
      ...mine,
      is_published: !mine!.is_published,
    });
    expect(roundTrip.status).toBe(200);
  });
});
