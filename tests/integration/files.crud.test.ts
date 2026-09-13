import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb, docFiles, type Database } from '@aeolus/db';
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
    cookieSecret: 'files-crud-test-secret',
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

interface Session {
  userId: string;
  cookie: string;
  docId: string;
}

async function freshUserAndDoc(
  fx: Fixtures,
  engine: 'latex' | 'typst' = 'latex',
): Promise<Session> {
  // dev/users + dev/sessions + POST /docs to mirror real provisioning.
  const u = await fx.db
    .insert(await import('@aeolus/db').then((m) => m.users))
    .values({
      email: `files-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
      // Admin so POST /docs below passes the issue-#39 gate. Tests
      // here exercise file-CRUD plumbing, not the admin-only-POST
      // semantics — those have dedicated coverage in docs.acl.test.ts.
      isAdmin: true,
    })
    .returning({ id: (await import('@aeolus/db')).users.id });
  const userId = u[0].id;
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const sc = sess.headers.get('set-cookie');
  const p = parseSetCookie(sc!);
  const cookie = `${p!.name}=${p!.value}`;
  const create = await fetch(`${fx.baseUrl}/api/docs`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Files CRUD', engine }),
  });
  const { id: docId } = (await create.json()) as { id: string };
  return { userId, cookie, docId };
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

describe('issue #9 phase 3C — file CRUD API', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('GET /files lists the main entrypoint after doc creation', async () => {
    const s = await freshUserAndDoc(fx, 'latex');
    const res = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: Array<{ path: string; kind: string; yjs_doc_id: string }>;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe('main.tex');
    expect(body.files[0].kind).toBe('text');
    // Phase-1 dual-write makes yjs_doc_id == docId for the main file.
    expect(body.files[0].yjs_doc_id).toBe(s.docId);
  });

  it('GET /files reports a size for text files (post-snapshot + tail bytes)', async () => {
    const { persistUpdate } = await import('@aeolus/crdt');
    const Y = await import('yjs');
    const s = await freshUserAndDoc(fx);

    // Empty new doc has no doc_updates rows for the main file —
    // size_bytes for text files defaults to 0 in that case (we
    // never report null for text files; that was the issue #41 bug).
    const empty = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    const emptyBody = (await empty.json()) as {
      files: Array<{ kind: string; size_bytes: number | null }>;
    };
    const main = emptyBody.files.find((f) => f.kind === 'text');
    expect(main?.size_bytes).toBe(0);

    // Stage some content via persistUpdate (no snapshot yet — pure
    // tail bytes). The reported size_bytes should equal the encoded
    // update length.
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, 'hello world');
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    await persistUpdate({ db: fx.db, blobs: fx.blobs }, s.docId, 0n, update, s.userId);

    const sized = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    const sizedBody = (await sized.json()) as {
      files: Array<{ kind: string; size_bytes: number | null }>;
    };
    const sizedMain = sizedBody.files.find((f) => f.kind === 'text');
    expect(sizedMain?.size_bytes).toBe(update.byteLength);
  });

  it('POST /files creates a text file with a fresh yjs_doc_id', async () => {
    const s = await freshUserAndDoc(fx);
    const res = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'chapters/intro.tex' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      file: { id: string; path: string; kind: string; yjs_doc_id: string };
    };
    expect(body.file.path).toBe('chapters/intro.tex');
    expect(body.file.kind).toBe('text');
    // Synthetic UUID, not docId.
    expect(body.file.yjs_doc_id).not.toBe(s.docId);
    expect(body.file.yjs_doc_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // listing returns 2.
    const list = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    const lb = (await list.json()) as { files: Array<{ path: string }> };
    expect(lb.files.map((f) => f.path).sort()).toEqual(['chapters/intro.tex', 'main.tex']);
  });

  it('POST /files refuses bad paths and duplicates', async () => {
    const s = await freshUserAndDoc(fx);
    // Traversal.
    const trav = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../etc/passwd' }),
    });
    expect(trav.status).toBe(400);
    const travBody = (await trav.json()) as { error: string };
    expect(travBody.error).toBe('invalid_path');

    // Empty segment.
    const empty = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a//b' }),
    });
    expect(empty.status).toBe(400);

    // Duplicate (main.tex already exists from POST /docs).
    const dup = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'main.tex' }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe('path_taken');
  });

  it('POST /files/upload writes a blob at a sub-folder path', async () => {
    const s = await freshUserAndDoc(fx);
    const fd = new FormData();
    fd.append('path', 'images/logo.png');
    fd.append('file', new File([new Uint8Array(PNG_1X1)], 'logo.png', { type: 'image/png' }));
    const res = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/upload`, {
      method: 'POST',
      headers: { cookie: s.cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      file: { path: string; kind: string; size_bytes: number; asset_id: string };
    };
    expect(body.file.path).toBe('images/logo.png');
    expect(body.file.kind).toBe('blob');
    expect(body.file.size_bytes).toBe(PNG_1X1.length);
    expect(body.file.asset_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // doc_files row exists at the nested path.
    const list = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    const lb = (await list.json()) as { files: Array<{ path: string; kind: string }> };
    expect(lb.files.find((f) => f.path === 'images/logo.png')?.kind).toBe('blob');
  });

  it('PATCH /files renames a file but refuses the main entrypoint', async () => {
    const s = await freshUserAndDoc(fx);
    // First create a renameable file.
    const create = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'old.tex' }),
    });
    const { file: created } = (await create.json()) as { file: { id: string } };

    const ok = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${created.id}`, {
      method: 'PATCH',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'new.tex' }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { file: { path: string } }).file.path).toBe('new.tex');

    // Find the main file and try to rename it.
    const list = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    const lb = (await list.json()) as { files: Array<{ id: string; path: string }> };
    const main = lb.files.find((f) => f.path === 'main.tex')!;

    const refuse = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${main.id}`, {
      method: 'PATCH',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'renamed.tex' }),
    });
    expect(refuse.status).toBe(422);
    expect(((await refuse.json()) as { error: string }).error).toBe('main_file_locked');
  });

  it('DELETE /files removes the row but refuses the main entrypoint', async () => {
    const s = await freshUserAndDoc(fx);
    const create = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'gone.tex' }),
    });
    const { file: created } = (await create.json()) as { file: { id: string } };

    const ok = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: s.cookie },
    });
    expect(ok.status).toBe(204);

    const remaining = await fx.db
      .select({ id: docFiles.id })
      .from(docFiles)
      .where(eq(docFiles.id, created.id));
    expect(remaining).toHaveLength(0);

    // Main file delete is refused.
    const list = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    const lb = (await list.json()) as { files: Array<{ id: string; path: string }> };
    const main = lb.files.find((f) => f.path === 'main.tex')!;
    const refuse = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${main.id}`, {
      method: 'DELETE',
      headers: { cookie: s.cookie },
    });
    expect(refuse.status).toBe(422);
    expect(((await refuse.json()) as { error: string }).error).toBe('main_file_locked');
  });

  it('POST /files with kind=folder creates an empty folder; PATCH renames cascade descendants; DELETE refuses non-empty folder (#42)', async () => {
    const s = await freshUserAndDoc(fx);

    // Create an empty folder.
    const mkFolder = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'chapters', kind: 'folder' }),
    });
    expect(mkFolder.status).toBe(201);
    const { file: folder } = (await mkFolder.json()) as {
      file: { id: string; path: string; kind: string };
    };
    expect(folder.kind).toBe('folder');
    expect(folder.path).toBe('chapters');

    // Add a text file inside the folder.
    const mkChild = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'chapters/intro.tex' }),
    });
    expect(mkChild.status).toBe(201);
    const { file: child } = (await mkChild.json()) as {
      file: { id: string };
    };

    // DELETE on a non-empty folder is refused with 422 folder_not_empty.
    const refuse = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${folder.id}`, {
      method: 'DELETE',
      headers: { cookie: s.cookie },
    });
    expect(refuse.status).toBe(422);
    const refuseBody = (await refuse.json()) as { error: string; children?: number };
    expect(refuseBody.error).toBe('folder_not_empty');
    expect(refuseBody.children).toBe(1);

    // PATCH (rename) cascades the descendant's path.
    const rename = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${folder.id}`, {
      method: 'PATCH',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'sections' }),
    });
    expect(rename.status).toBe(200);
    const list = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      headers: { cookie: s.cookie },
    });
    const listed = (await list.json()) as {
      files: Array<{ id: string; path: string; kind: string }>;
    };
    expect(listed.files.find((f) => f.id === folder.id)?.path).toBe('sections');
    expect(listed.files.find((f) => f.id === child.id)?.path).toBe('sections/intro.tex');

    // Empty the folder, then DELETE succeeds.
    await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${child.id}`, {
      method: 'DELETE',
      headers: { cookie: s.cookie },
    });
    const empty = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files/${folder.id}`, {
      method: 'DELETE',
      headers: { cookie: s.cookie },
    });
    expect(empty.status).toBe(204);
  });

  it('POST /files with kind=folder rejects collision with an existing path', async () => {
    const s = await freshUserAndDoc(fx);
    // main.tex already exists.
    const collide = await fetch(`${fx.baseUrl}/api/docs/${s.docId}/files`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'main.tex', kind: 'folder' }),
    });
    expect(collide.status).toBe(409);
    expect(((await collide.json()) as { error: string }).error).toBe('path_taken');
  });

  // #82: forked docs reference the template's blobs by storage key
  // (templates.ts fork route) — the S3 object has ONE copy shared by
  // N doc_files rows. Deleting one row must not destroy the bytes
  // while any other row still points at them; deleting the LAST row
  // still must (no orphan leak).
  it('DELETE /files keeps shared blob bytes until the last referencing row is gone (#82)', async () => {
    const a = await freshUserAndDoc(fx);
    const b = await freshUserAndDoc(fx);

    // Upload a blob into doc A the normal way.
    const fd = new FormData();
    fd.append('path', 'fonts/Some Custom Face.ttf');
    fd.append('file', new Blob([PNG_1X1]), 'Some Custom Face.ttf');
    const up = await fetch(`${fx.baseUrl}/api/docs/${a.docId}/files/upload`, {
      method: 'POST',
      headers: { cookie: a.cookie },
      body: fd,
    });
    expect(up.status).toBe(201);
    const { file: uploaded } = (await up.json()) as { file: { id: string } };

    const [rowA] = await fx.db
      .select({ storageKey: docFiles.storageKey })
      .from(docFiles)
      .where(eq(docFiles.id, uploaded.id));
    const storageKey = rowA.storageKey!;
    expect(await fx.blobs.get(storageKey)).not.toBeNull();

    // Doc B references the SAME storage key — the shape the fork
    // route creates (new row, same bytes).
    const [rowB] = await fx.db
      .insert(docFiles)
      .values({
        docId: b.docId,
        path: 'fonts/Some Custom Face.ttf',
        kind: 'blob',
        storageKey,
        filename: 'Some Custom Face.ttf',
        mimeType: 'font/ttf',
        sizeBytes: PNG_1X1.length,
        uploadedBy: b.userId,
      })
      .returning({ id: docFiles.id });

    // Deleting doc A's row removes the row but NOT the shared bytes.
    const delA = await fetch(`${fx.baseUrl}/api/docs/${a.docId}/files/${uploaded.id}`, {
      method: 'DELETE',
      headers: { cookie: a.cookie },
    });
    expect(delA.status).toBe(204);
    expect(await fx.blobs.get(storageKey)).not.toBeNull();

    // Deleting the last referencing row drops the bytes too.
    const delB = await fetch(`${fx.baseUrl}/api/docs/${b.docId}/files/${rowB.id}`, {
      method: 'DELETE',
      headers: { cookie: b.cookie },
    });
    expect(delB.status).toBe(204);
    expect(await fx.blobs.get(storageKey)).toBeNull();
  });

  // Same guard on the legacy /assets delete surface — it has its own
  // copy of the S3-delete logic and rotted the same way.
  it('DELETE /assets (legacy route) also keeps shared blob bytes (#82)', async () => {
    const a = await freshUserAndDoc(fx);
    const b = await freshUserAndDoc(fx);

    const fd = new FormData();
    fd.append('file', new Blob([PNG_1X1]), 'logo.png');
    const up = await fetch(`${fx.baseUrl}/api/docs/${a.docId}/assets`, {
      method: 'POST',
      headers: { cookie: a.cookie },
      body: fd,
    });
    expect(up.status).toBe(201);
    const { asset } = (await up.json()) as { asset: { id: string } };

    const [rowA] = await fx.db
      .select({ storageKey: docFiles.storageKey })
      .from(docFiles)
      .where(eq(docFiles.id, asset.id));
    const storageKey = rowA.storageKey!;

    await fx.db.insert(docFiles).values({
      docId: b.docId,
      path: 'logo.png',
      kind: 'blob',
      storageKey,
      filename: 'logo.png',
      mimeType: 'image/png',
      sizeBytes: PNG_1X1.length,
      uploadedBy: b.userId,
    });

    const delA = await fetch(`${fx.baseUrl}/api/docs/${a.docId}/assets/${asset.id}`, {
      method: 'DELETE',
      headers: { cookie: a.cookie },
    });
    expect(delA.status).toBe(204);
    expect(await fx.blobs.get(storageKey)).not.toBeNull();
  });
});
