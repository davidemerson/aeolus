import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, docFiles, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

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
    cookieSecret: 'v1-templates-test-secret',
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
async function persona(isAdmin = false) {
  const email = `v1tmpl-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email, isAdmin }).returning({ id: users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
  const cookie = `${c.name}=${c.value}`;
  const mint = async (scope: 'read' | 'write') =>
    (
      await json<{ token: string }>(
        await fetch(`${fx.baseUrl}/api/tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: `${scope}-${seq}`, scope }),
        }),
      )
    ).token;
  return { userId: user.id, email, cookie, read: await mint('read'), write: await mint('write') };
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

let admin: Awaited<ReturnType<typeof persona>>;
async function makeTemplate(publish: boolean, name = `t-${seq++}`) {
  admin ??= await persona(true);
  const { template } = await json<{ template: { id: string; yjs_doc_id: string } }>(
    await v1(admin.write, '/templates', {
      method: 'POST',
      body: JSON.stringify({ name, engine: 'latex' }),
    }),
  );
  if (publish) {
    await v1(admin.write, `/templates/${template.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_published: true }),
    });
  }
  return template;
}

describe('/api/v1/templates', () => {
  it('creates a template with a backing document and an entrypoint', async () => {
    const t = await makeTemplate(false, 'with-backing-doc');
    const [doc] = await fx.db.select().from(docs).where(eq(docs.id, t.yjs_doc_id));
    expect(doc.isTemplateDoc).toBe(true);
    const files = await fx.db.select().from(docFiles).where(eq(docFiles.docId, t.yjs_doc_id));
    expect(files.map((f) => f.path)).toEqual(['main.tex']);
  });

  it('hides an unpublished draft from non-admins, in both list and get', async () => {
    const user = await persona(false);
    const draft = await makeTemplate(false, 'still-a-draft');

    const listed = (
      await json<{ templates: Array<{ id: string }> }>(await v1(user.read, '/templates'))
    ).templates.map((t) => t.id);
    expect(listed).not.toContain(draft.id);
    // 404, not 403 — existence stays hidden, as with documents.
    expect((await v1(user.read, `/templates/${draft.id}`)).status).toBe(404);

    // The admin sees it.
    expect((await v1(admin.read, `/templates/${draft.id}`)).status).toBe(200);
  });

  it('publishing makes it visible', async () => {
    const user = await persona(false);
    const t = await makeTemplate(true, 'published-one');
    expect((await v1(user.read, `/templates/${t.id}`)).status).toBe(200);
    expect(
      (
        await json<{ templates: Array<{ id: string }> }>(await v1(user.read, '/templates'))
      ).templates.map((x) => x.id),
    ).toContain(t.id);
  });

  it('refuses create, update and delete to a non-admin', async () => {
    const user = await persona(false);
    const t = await makeTemplate(true);
    for (const [method, path, body] of [
      ['POST', '/templates', { name: 'x', engine: 'latex' }],
      ['PATCH', `/templates/${t.id}`, { name: 'y' }],
      ['DELETE', `/templates/${t.id}`, undefined],
    ] as const) {
      const res = await v1(user.write, path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await json<{ error: string }>(res)).error).toBe('forbidden');
    }
  });

  it('deleting a template also removes its backing document', async () => {
    const t = await makeTemplate(true, 'to-delete');
    expect((await v1(admin.write, `/templates/${t.id}`, { method: 'DELETE' })).status).toBe(204);
    const [doc] = await fx.db.select().from(docs).where(eq(docs.id, t.yjs_doc_id));
    expect(doc.deletedAt).not.toBeNull();
    expect((await v1(admin.read, `/templates/${t.id}`)).status).toBe(404);
  });
});

describe('/api/v1/templates/:id/fork — how non-admins create anything', () => {
  it('forks a published template into a document the caller owns', async () => {
    const user = await persona(false);
    const t = await makeTemplate(true, 'forkable');

    const res = await v1(user.write, `/templates/${t.id}/fork`, {
      method: 'POST',
      body: JSON.stringify({ title: 'My paper' }),
    });
    expect(res.status).toBe(201);
    const forked = await json<{ doc_id: string; title: string; text_files_copied: number }>(res);
    expect(forked.title).toBe('My paper');

    const [doc] = await fx.db.select().from(docs).where(eq(docs.id, forked.doc_id));
    expect(doc.ownerId).toBe(user.userId);
    expect(doc.forkedFromTemplate).toBe(t.id);
    expect(doc.isTemplateDoc).toBe(false);

    // The fork is reachable through the documents plane as the caller's own.
    expect((await v1(user.read, `/docs/${forked.doc_id}`)).status).toBe(200);
  });

  it('copies EVERY text file, not just the entrypoint (#36)', async () => {
    const user = await persona(false);
    const t = await makeTemplate(true, 'multi-file');

    // Put a sibling into the template's backing project and give both content.
    const main = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${t.yjs_doc_id}/files`),
      )
    ).files.find((f) => f.path === 'main.tex')!;
    await v1(admin.write, `/docs/${t.yjs_doc_id}/files/${main.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: '\\input{frontmatter.tex}\nmain body' }),
    });
    const sibling = await json<{ file: { id: string } }>(
      await v1(admin.write, `/docs/${t.yjs_doc_id}/files`, {
        method: 'POST',
        body: JSON.stringify({ path: 'frontmatter.tex' }),
      }),
    );
    await v1(admin.write, `/docs/${t.yjs_doc_id}/files/${sibling.file.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'shared frontmatter' }),
    });

    await v1(admin.write, `/templates/${t.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_published: true }),
    });

    const forked = await json<{ doc_id: string; text_files_copied: number }>(
      await v1(user.write, `/templates/${t.id}/fork`, { method: 'POST' }),
    );
    expect(forked.text_files_copied).toBe(2);

    const files = (
      await json<{ files: Array<{ id: string; path: string; yjs_doc_id: string | null }> }>(
        await v1(user.read, `/docs/${forked.doc_id}/files`),
      )
    ).files;
    expect(files.map((f) => f.path).sort()).toEqual(['frontmatter.tex', 'main.tex']);

    // Main keeps yjs_doc_id == docs.id; the sibling gets a fresh one.
    const forkedMain = files.find((f) => f.path === 'main.tex')!;
    const forkedSibling = files.find((f) => f.path === 'frontmatter.tex')!;
    expect(forkedMain.yjs_doc_id).toBe(forked.doc_id);
    expect(forkedSibling.yjs_doc_id).not.toBe(forked.doc_id);

    // And the CONTENT came with them — the thing #36 was about.
    const mainContent = await json<{ content: string }>(
      await v1(user.read, `/docs/${forked.doc_id}/files/${forkedMain.id}/content`),
    );
    expect(mainContent.content).toContain('\\input{frontmatter.tex}');
    const sibContent = await json<{ content: string }>(
      await v1(user.read, `/docs/${forked.doc_id}/files/${forkedSibling.id}/content`),
    );
    expect(sibContent.content).toBe('shared frontmatter');
  });

  it('copies blobs BY REFERENCE, so the fork and template share the object', async () => {
    const user = await persona(false);
    const t = await makeTemplate(false, 'with-a-logo');

    const form = new FormData();
    form.append('path', 'logo.png');
    form.append('file', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'logo.png');
    await fetch(`${fx.baseUrl}/api/v1/docs/${t.yjs_doc_id}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.write}` },
      body: form,
    });
    await v1(admin.write, `/templates/${t.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_published: true }),
    });

    const forked = await json<{ doc_id: string; blobs_copied: number }>(
      await v1(user.write, `/templates/${t.id}/fork`, { method: 'POST' }),
    );
    expect(forked.blobs_copied).toBe(1);

    const templateKey = (
      await fx.db.select().from(docFiles).where(eq(docFiles.docId, t.yjs_doc_id))
    ).find((f) => f.kind === 'blob')!.storageKey;
    const forkKey = (
      await fx.db.select().from(docFiles).where(eq(docFiles.docId, forked.doc_id))
    ).find((f) => f.kind === 'blob')!.storageKey;
    // Same object, not a copy — duplicating bytes per fork would explode
    // storage for a popular template and buys nothing.
    expect(forkKey).toBe(templateKey);
  });

  it("forks with no request body at all, taking the template's name", async () => {
    const user = await persona(false);
    const t = await makeTemplate(true, 'default-title-template');
    // Fastify presents an absent body as null; the schema has to accept that,
    // because this is the natural way to fork.
    const res = await v1(user.write, `/templates/${t.id}/fork`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect((await json<{ title: string }>(res)).title).toBe('default-title-template');
  });

  it('refuses to fork an unpublished draft, as a 404', async () => {
    const user = await persona(false);
    const draft = await makeTemplate(false, 'unforkable');
    expect((await v1(user.write, `/templates/${draft.id}/fork`, { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('a read token cannot fork', async () => {
    const user = await persona(false);
    const t = await makeTemplate(true);
    const res = await v1(user.read, `/templates/${t.id}/fork`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('read_only_token');
  });
});
