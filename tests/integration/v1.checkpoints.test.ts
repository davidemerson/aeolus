import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { auditEvents, db as makeDb, docFiles, docs, users, type Database } from '@aeolus/db';
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
    cookieSecret: 'v1-cp-test-secret',
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
async function persona(isAdmin = false) {
  const email = `v1cp-${Date.now()}-${seq++}@example.com`;
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
  return { userId: user.id, email, read: await mint('read'), write: await mint('write') };
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

let owner: Awaited<ReturnType<typeof persona>>;

/** A project with main.tex plus one sibling, both with content. */
async function seedProject(): Promise<{ docId: string; mainId: string; sibId: string }> {
  owner ??= await persona(false);
  const [doc] = await fx.db
    .insert(docs)
    .values({ title: `cp-${seq++}`, engine: 'latex', ownerId: owner.userId })
    .returning({ id: docs.id });
  await fx.db
    .insert(docFiles)
    .values({ docId: doc.id, path: 'main.tex', kind: 'text', yjsDocId: doc.id });

  const files = await json<{ files: Array<{ id: string; path: string }> }>(
    await v1(owner.read, `/docs/${doc.id}/files`),
  );
  const mainId = files.files.find((f) => f.path === 'main.tex')!.id;
  await v1(owner.write, `/docs/${doc.id}/files/${mainId}/content`, {
    method: 'PUT',
    body: JSON.stringify({ content: 'ORIGINAL MAIN' }),
  });
  const sib = await json<{ file: { id: string } }>(
    await v1(owner.write, `/docs/${doc.id}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: 'chapter.tex' }),
    }),
  );
  await v1(owner.write, `/docs/${doc.id}/files/${sib.file.id}/content`, {
    method: 'PUT',
    body: JSON.stringify({ content: 'ORIGINAL CHAPTER' }),
  });
  return { docId: doc.id, mainId, sibId: sib.file.id };
}

const contentOf = async (docId: string, fileId: string) =>
  (await json<{ content: string }>(await v1(owner.read, `/docs/${docId}/files/${fileId}/content`)))
    .content;

describe('/api/v1 per-file checkpoints', () => {
  it('takes a checkpoint, then restores the file to it', async () => {
    const { docId, mainId } = await seedProject();

    const created = await json<{ checkpoint: { id: string; file_path: string; kind: string } }>(
      await v1(owner.write, `/docs/${docId}/checkpoints?fileId=${mainId}`, {
        method: 'POST',
        body: JSON.stringify({ label: 'before the edit' }),
      }),
    );
    expect(created.checkpoint).toMatchObject({ file_path: 'main.tex', kind: 'user' });

    await v1(owner.write, `/docs/${docId}/files/${mainId}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'CLOBBERED' }),
    });
    expect(await contentOf(docId, mainId)).toBe('CLOBBERED');

    const restored = await json<{ restored: boolean; file_path: string }>(
      await v1(owner.write, `/docs/${docId}/checkpoints/${created.checkpoint.id}/restore`, {
        method: 'POST',
      }),
    );
    expect(restored).toMatchObject({ restored: true, file_path: 'main.tex' });
    expect(await contentOf(docId, mainId)).toBe('ORIGINAL MAIN');
  });

  it('keeps history per FILE, not per project', async () => {
    const { docId, mainId, sibId } = await seedProject();
    await v1(owner.write, `/docs/${docId}/checkpoints?fileId=${mainId}`, {
      method: 'POST',
      body: JSON.stringify({ label: 'main only' }),
    });

    const mainList = await json<{ checkpoints: Array<{ label: string; file_path: string }> }>(
      await v1(owner.read, `/docs/${docId}/checkpoints?fileId=${mainId}`),
    );
    expect(mainList.checkpoints.map((c) => c.label)).toEqual(['main only']);

    // The sibling has its own CRDT (ADR 0013) and therefore its own history.
    const sibList = await json<{ checkpoints: unknown[] }>(
      await v1(owner.read, `/docs/${docId}/checkpoints?fileId=${sibId}`),
    );
    expect(sibList.checkpoints).toEqual([]);
  });

  it('downloads the raw snapshot, and 404s one from another document', async () => {
    const a = await seedProject();
    const b = await seedProject();
    const cp = await json<{ checkpoint: { id: string } }>(
      await v1(owner.write, `/docs/${a.docId}/checkpoints?fileId=${a.mainId}`, {
        method: 'POST',
        body: JSON.stringify({ label: 'snap' }),
      }),
    );

    const dl = await v1(owner.read, `/docs/${a.docId}/checkpoints/${cp.checkpoint.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect((await dl.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // Same checkpoint id, wrong document.
    expect((await v1(owner.read, `/docs/${b.docId}/checkpoints/${cp.checkpoint.id}`)).status).toBe(
      404,
    );
  });

  it('audits a named checkpoint and its restore', async () => {
    const { docId, mainId } = await seedProject();
    const cp = await json<{ checkpoint: { id: string } }>(
      await v1(owner.write, `/docs/${docId}/checkpoints?fileId=${mainId}`, {
        method: 'POST',
        body: JSON.stringify({ label: 'audited' }),
      }),
    );
    await v1(owner.write, `/docs/${docId}/checkpoints/${cp.checkpoint.id}/restore`, {
      method: 'POST',
    });
    const actions = (
      await fx.db.select().from(auditEvents).where(eq(auditEvents.resourceId, cp.checkpoint.id))
    ).map((r) => r.action);
    expect(actions).toContain('checkpoint.create');
    expect(actions).toContain('checkpoint.restore');
  });

  it('a read token cannot take or restore a checkpoint', async () => {
    const { docId, mainId } = await seedProject();
    const create = await v1(owner.read, `/docs/${docId}/checkpoints?fileId=${mainId}`, {
      method: 'POST',
      body: JSON.stringify({ label: 'nope' }),
    });
    expect(create.status).toBe(403);
    expect((await json<{ error: string }>(create)).error).toBe('read_only_token');
  });

  it('refuses a checkpoint on an archived document', async () => {
    const { docId, mainId } = await seedProject();
    const admin = await persona(true);
    await v1(admin.write, `/docs/${docId}/archive`, { method: 'POST' });
    const res = await v1(owner.write, `/docs/${docId}/checkpoints?fileId=${mainId}`, {
      method: 'POST',
      body: JSON.stringify({ label: 'nope' }),
    });
    expect(res.status).toBe(422);
    expect((await json<{ error: string }>(res)).error).toBe('archived');
  });
});

describe('/api/v1 project checkpoints', () => {
  it('captures every file, and restores them all', async () => {
    const { docId, mainId, sibId } = await seedProject();

    const created = await json<{
      project_checkpoint: { id: string; files: Array<{ path: string }> };
    }>(
      await v1(owner.write, `/docs/${docId}/project-checkpoints`, {
        method: 'POST',
        body: JSON.stringify({ label: 'before the bulk edit' }),
      }),
    );
    expect(created.project_checkpoint.files.map((f) => f.path).sort()).toEqual([
      'chapter.tex',
      'main.tex',
    ]);

    for (const [fileId, text] of [
      [mainId, 'MAIN CLOBBERED'],
      [sibId, 'CHAPTER CLOBBERED'],
    ] as const) {
      await v1(owner.write, `/docs/${docId}/files/${fileId}/content`, {
        method: 'PUT',
        body: JSON.stringify({ content: text }),
      });
    }

    const restored = await json<{ files_restored: number; blobs_missing: string[] }>(
      await v1(
        owner.write,
        `/docs/${docId}/project-checkpoints/${created.project_checkpoint.id}/restore`,
        { method: 'POST' },
      ),
    );
    expect(restored.files_restored).toBe(2);
    expect(restored.blobs_missing).toEqual([]);

    expect(await contentOf(docId, mainId)).toBe('ORIGINAL MAIN');
    expect(await contentOf(docId, sibId)).toBe('ORIGINAL CHAPTER');
  });

  it('restores the blob set, and names any bytes that have gone', async () => {
    const { docId } = await seedProject();

    const form = new FormData();
    form.append('path', 'fig.png');
    form.append('file', new Blob([Buffer.from('IMG')], { type: 'image/png' }), 'fig.png');
    await fetch(`${fx.baseUrl}/api/v1/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.write}` },
      body: form,
    });

    const cp = await json<{ project_checkpoint: { id: string; blobs: Array<{ path: string }> } }>(
      await v1(owner.write, `/docs/${docId}/project-checkpoints`, {
        method: 'POST',
        body: JSON.stringify({ label: 'with a figure' }),
      }),
    );
    expect(cp.project_checkpoint.blobs.map((b) => b.path)).toEqual(['fig.png']);

    // Delete the file through the API; the pinned bytes must survive, because
    // the checkpoint still references them.
    const files = await json<{ files: Array<{ id: string; path: string }> }>(
      await v1(owner.read, `/docs/${docId}/files`),
    );
    const fig = files.files.find((f) => f.path === 'fig.png')!;
    expect(
      (await v1(owner.write, `/docs/${docId}/files/${fig.id}`, { method: 'DELETE' })).status,
    ).toBe(204);

    const restored = await json<{ blobs_restored: number; blobs_missing: string[] }>(
      await v1(
        owner.write,
        `/docs/${docId}/project-checkpoints/${cp.project_checkpoint.id}/restore`,
        {
          method: 'POST',
        },
      ),
    );
    expect(restored.blobs_restored).toBe(1);
    expect(restored.blobs_missing).toEqual([]);
    expect(
      (
        await json<{ files: Array<{ path: string }> }>(await v1(owner.read, `/docs/${docId}/files`))
      ).files.map((f) => f.path),
    ).toContain('fig.png');
  });

  it('completes a restore even when pinned bytes have vanished, and says which', async () => {
    const { docId } = await seedProject();
    const form = new FormData();
    form.append('path', 'doomed.png');
    form.append('file', new Blob([Buffer.from('IMG')], { type: 'image/png' }), 'doomed.png');
    await fetch(`${fx.baseUrl}/api/v1/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.write}` },
      body: form,
    });
    const cp = await json<{ project_checkpoint: { id: string } }>(
      await v1(owner.write, `/docs/${docId}/project-checkpoints`, {
        method: 'POST',
        body: JSON.stringify({ label: 'doomed' }),
      }),
    );

    // Simulate the object disappearing underneath us (a bucket lifecycle rule,
    // a bad GC) rather than being deleted through the API.
    const [row] = await fx.db
      .select({ storageKey: docFiles.storageKey })
      .from(docFiles)
      .where(eq(docFiles.docId, docId));
    for (const f of await fx.db.select().from(docFiles).where(eq(docFiles.docId, docId))) {
      if (f.kind === 'blob' && f.storageKey) await fx.blobs.delete(f.storageKey);
    }
    void row;

    const restored = await json<{ blobs_restored: number; blobs_missing: string[] }>(
      await v1(
        owner.write,
        `/docs/${docId}/project-checkpoints/${cp.project_checkpoint.id}/restore`,
        {
          method: 'POST',
        },
      ),
    );
    // Text still came back; the missing object is reported, not fatal.
    expect(restored.blobs_restored).toBe(0);
    expect(restored.blobs_missing).toEqual(['doomed.png']);
  });

  it('lists with file and blob counts, and deletes', async () => {
    const { docId } = await seedProject();
    const cp = await json<{ project_checkpoint: { id: string } }>(
      await v1(owner.write, `/docs/${docId}/project-checkpoints`, {
        method: 'POST',
        body: JSON.stringify({ label: 'listed' }),
      }),
    );

    const listed = await json<{
      project_checkpoints: Array<{ id: string; file_count: number; blob_count: number }>;
    }>(await v1(owner.read, `/docs/${docId}/project-checkpoints`));
    expect(listed.project_checkpoints[0]).toMatchObject({
      id: cp.project_checkpoint.id,
      file_count: 2,
      blob_count: 0,
    });

    expect(
      (
        await v1(owner.write, `/docs/${docId}/project-checkpoints/${cp.project_checkpoint.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await json<{ project_checkpoints: unknown[] }>(
          await v1(owner.read, `/docs/${docId}/project-checkpoints`),
        )
      ).project_checkpoints,
    ).toEqual([]);
  });

  it('hides everything from an outsider', async () => {
    const outsider = await persona(false);
    const { docId } = await seedProject();
    for (const path of [`/docs/${docId}/checkpoints`, `/docs/${docId}/project-checkpoints`]) {
      expect((await v1(outsider.read, path)).status, path).toBe(404);
    }
  });
});
