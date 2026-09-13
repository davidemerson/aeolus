import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { auditEvents, db as makeDb, docFiles, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
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
    cookieSecret: 'v1-files-test-secret',
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
    blobs,
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
let admin: { userId: string; email: string; cookie: string; read: string; write: string };

async function persona(isAdmin = false) {
  const email = `v1files-${Date.now()}-${seq++}@example.com`;
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

async function newProject(): Promise<string> {
  admin ??= await persona(true);
  const res = await v1(admin.write, '/docs', {
    method: 'POST',
    body: JSON.stringify({ title: `p-${seq++}`, engine: 'latex' }),
  });
  return (await json<{ id: string }>(res)).id;
}

describe('/api/v1 file tree', () => {
  it('lists the entrypoint a new project is created with', async () => {
    const docId = await newProject();
    const { files } = await json<{ files: Array<Record<string, unknown>> }>(
      await v1(admin.read, `/docs/${docId}/files`),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'main.tex', kind: 'text' });
    expect(files[0].yjs_doc_id).toBe(docId);
  });

  it('creates text files and folders, and refuses a duplicate path', async () => {
    const docId = await newProject();
    const mk = (body: unknown) =>
      v1(admin.write, `/docs/${docId}/files`, { method: 'POST', body: JSON.stringify(body) });

    expect((await mk({ path: 'chapters', kind: 'folder' })).status).toBe(201);
    const created = await json<{ file: { id: string; yjs_doc_id: string | null } }>(
      await mk({ path: 'chapters/intro.tex' }),
    );
    // A sibling text file gets its OWN CRDT document — only the entrypoint
    // reuses docs.id (ADR 0013).
    expect(created.file.yjs_doc_id).not.toBeNull();
    expect(created.file.yjs_doc_id).not.toBe(docId);

    const dup = await mk({ path: 'chapters/intro.tex' });
    expect(dup.status).toBe(409);
    expect((await json<{ error: string }>(dup)).error).toBe('path_taken');
  });

  it.each([
    ['traversal', '../escape.tex'],
    ['traversal mid-path', 'a/../../b.tex'],
    ['dot segment', 'a/./b.tex'],
    ['empty segment', 'a//b.tex'],
    ['bare ..', '..'],
  ])('refuses a %s path', async (_label, badPath) => {
    const docId = await newProject();
    const res = await v1(admin.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: badPath }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('invalid_path');
  });

  // A leading slash is STRIPPED, not rejected, so `/etc/passwd` becomes the
  // relative `etc/passwd`. That is safe and worth pinning because it reads
  // alarmingly: paths only ever name rows in this document's own file tree,
  // they are never resolved against a filesystem by the API. What the compile
  // worker does with them is bounded by its own sandbox.
  it('normalises a leading slash rather than rejecting it', async () => {
    const docId = await newProject();
    const res = await v1(admin.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: '/etc/passwd' }),
    });
    expect(res.status).toBe(201);
    expect((await json<{ file: { path: string } }>(res)).file.path).toBe('etc/passwd');
  });

  it('renames, cascades a folder rename, and locks the entrypoint', async () => {
    const docId = await newProject();
    await v1(admin.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: 'ch', kind: 'folder' }),
    });
    const folder = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'ch')!;
    await v1(admin.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: 'ch/one.tex' }),
    });

    expect(
      (
        await v1(admin.write, `/docs/${docId}/files/${folder.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ path: 'parts' }),
        })
      ).status,
    ).toBe(200);

    const paths = (
      await json<{ files: Array<{ path: string }> }>(await v1(admin.read, `/docs/${docId}/files`))
    ).files.map((f) => f.path);
    expect(paths).toContain('parts');
    expect(paths).toContain('parts/one.tex');
    expect(paths).not.toContain('ch/one.tex');

    const main = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'main.tex')!;
    const locked = await v1(admin.write, `/docs/${docId}/files/${main.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ path: 'renamed.tex' }),
    });
    expect(locked.status).toBe(422);
    expect((await json<{ error: string }>(locked)).error).toBe('main_file_locked');
  });

  it('refuses to delete a non-empty folder, and says how many are inside', async () => {
    const docId = await newProject();
    await v1(admin.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: 'dir', kind: 'folder' }),
    });
    await v1(admin.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: 'dir/a.tex' }),
    });
    const dir = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'dir')!;

    const res = await v1(admin.write, `/docs/${docId}/files/${dir.id}`, { method: 'DELETE' });
    expect(res.status).toBe(422);
    // `children` is part of the contract — the count survives the error path.
    expect(await json<{ error: string; children: number }>(res)).toMatchObject({
      error: 'folder_not_empty',
      children: 1,
    });
  });
});

describe('/api/v1 file content — the point of the plane', () => {
  it('round-trips LaTeX, including the constructs the WAF used to block', async () => {
    const docId = await newProject();
    const main = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'main.tex')!;

    // A blank new document reads as empty rather than erroring.
    const before = await json<{ content: string; rev: string }>(
      await v1(admin.read, `/docs/${docId}/files/${main.id}/content`),
    );
    expect(before.content).toBe('');

    const source = [
      '\\documentclass{article}',
      '\\input{../shared/preamble.tex}',
      '\\begin{document}',
      'Let $a < b$ and $b > c$.',
      '\\begin{verbatim}<script>alert("xss")</script>\\end{verbatim}',
      '\\end{document}',
    ].join('\n');

    const put = await v1(admin.write, `/docs/${docId}/files/${main.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: source }),
    });
    expect(put.status).toBe(200);

    const after = await json<{ content: string; rev: string }>(
      await v1(admin.read, `/docs/${docId}/files/${main.id}/content`),
    );
    expect(after.content).toBe(source);
    expect(BigInt(after.rev)).toBeGreaterThan(BigInt(before.rev));
  });

  it('honours if_rev, and reports the current revision when it does not match', async () => {
    const docId = await newProject();
    const main = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'main.tex')!;

    const first = await json<{ rev: string }>(
      await v1(admin.read, `/docs/${docId}/files/${main.id}/content`),
    );

    // Correct rev: accepted.
    expect(
      (
        await v1(admin.write, `/docs/${docId}/files/${main.id}/content`, {
          method: 'PUT',
          body: JSON.stringify({ content: 'one', if_rev: first.rev }),
        })
      ).status,
    ).toBe(200);

    // Stale rev: refused, and the response says what it actually is now, so a
    // client can re-read without guessing.
    const stale = await v1(admin.write, `/docs/${docId}/files/${main.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'two', if_rev: first.rev }),
    });
    expect(stale.status).toBe(412);
    const body = await json<{ error: string; rev: string }>(stale);
    expect(body.error).toBe('revision_mismatch');
    expect(BigInt(body.rev)).toBeGreaterThan(BigInt(first.rev));

    // The refused write did not land.
    expect(
      (
        await json<{ content: string }>(
          await v1(admin.read, `/docs/${docId}/files/${main.id}/content`),
        )
      ).content,
    ).toBe('one');
  });

  it('refuses content operations on a folder', async () => {
    const docId = await newProject();
    await v1(admin.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: 'dir', kind: 'folder' }),
    });
    const dir = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'dir')!;

    const res = await v1(admin.read, `/docs/${docId}/files/${dir.id}/content`);
    expect(res.status).toBe(422);
    expect((await json<{ error: string }>(res)).error).toBe('not_a_text_file');
  });

  it('a read token cannot write content', async () => {
    const docId = await newProject();
    const main = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'main.tex')!;
    const res = await v1(admin.read, `/docs/${docId}/files/${main.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'nope' }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('read_only_token');
  });

  it('audits a content write with the path and the byte count', async () => {
    const docId = await newProject();
    const main = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(admin.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'main.tex')!;
    await v1(admin.write, `/docs/${docId}/files/${main.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'hello' }),
    });
    const rows = await fx.db.select().from(auditEvents).where(eq(auditEvents.resourceId, main.id));
    const write = rows.find((r) => r.action === 'file.write');
    expect(write).toBeDefined();
    expect(write!.metadata).toMatchObject({ path: 'main.tex', bytes: 5, via: 'api_token' });
  });
});

describe('/api/v1 blob upload', () => {
  it('accepts an allowlisted file and refuses one that is not', async () => {
    const docId = await newProject();

    const ok = new FormData();
    ok.append('path', 'figures/plot.png');
    ok.append(
      'file',
      new Blob([Buffer.from('\x89PNG\r\n\x1a\n')], { type: 'image/png' }),
      'plot.png',
    );
    const res = await fetch(`${fx.baseUrl}/api/v1/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.write}` },
      body: ok,
    });
    expect(res.status).toBe(201);
    const { file } = await json<{ file: { path: string; mime_type: string } }>(res);
    expect(file).toMatchObject({ path: 'figures/plot.png', mime_type: 'image/png' });

    const bad = new FormData();
    bad.append('path', 'evil.sh');
    bad.append('file', new Blob([Buffer.from('#!/bin/sh')]), 'evil.sh');
    const rejected = await fetch(`${fx.baseUrl}/api/v1/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.write}` },
      body: bad,
    });
    expect(rejected.status).toBe(400);
    expect((await json<{ error: string }>(rejected)).error).toBe('unsupported_type');
  });

  it('keeps the bytes when another row still references them', async () => {
    const docId = await newProject();
    const form = new FormData();
    form.append('path', 'shared.png');
    form.append('file', new Blob([Buffer.from('bytes')], { type: 'image/png' }), 'shared.png');
    const up = await fetch(`${fx.baseUrl}/api/v1/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.write}` },
      body: form,
    });
    const { file } = await json<{ file: { id: string } }>(up);

    const [row] = await fx.db
      .select({ storageKey: docFiles.storageKey })
      .from(docFiles)
      .where(eq(docFiles.id, file.id));
    const key = row.storageKey!;

    // A second row pointing at the same object — what a template fork produces.
    await fx.db.insert(docFiles).values({
      docId,
      path: 'copy.png',
      kind: 'blob',
      storageKey: key,
      filename: 'copy.png',
      mimeType: 'image/png',
      sizeBytes: 5,
    });

    expect(
      (await v1(admin.write, `/docs/${docId}/files/${file.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    // The row went; the bytes did not, because the copy still needs them (#82).
    expect(await fx.blobs.get(key)).not.toBeNull();
  });
});
