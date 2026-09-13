import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { loadDoc, MemoryBlobStore, persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { db as makeDb, type Database } from '@aeolus/db';
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
    cookieSecret: 'project-cp-test-secret',
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

interface Project {
  cookie: string;
  docId: string;
  introFileId: string;
  introYjsDocId: string;
}

async function freshProject(fx: Fixtures): Promise<Project> {
  // Admin so POST /docs below passes the issue-#39 gate.
  const u = await fx.db
    .insert(await import('@aeolus/db').then((m) => m.users))
    .values({
      email: `proj-cp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
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
    body: JSON.stringify({ title: 'Project CP', engine: 'latex' }),
  });
  const { id: docId } = (await create.json()) as { id: string };

  const introCreate = await fetch(`${fx.baseUrl}/api/docs/${docId}/files`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'chapters/intro.tex' }),
  });
  const { file: intro } = (await introCreate.json()) as {
    file: { id: string; yjs_doc_id: string };
  };

  const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
  {
    const y = new Y.Doc();
    y.getText('source').insert(0, 'MAIN v1');
    await persistUpdate(crdtDeps, docId, 0n, Y.encodeStateAsUpdate(y), null);
    y.destroy();
  }
  {
    const y = new Y.Doc();
    y.getText('source').insert(0, 'INTRO v1');
    await persistUpdate(crdtDeps, intro.yjs_doc_id, 0n, Y.encodeStateAsUpdate(y), null);
    y.destroy();
  }

  return {
    cookie,
    docId,
    introFileId: intro.id,
    introYjsDocId: intro.yjs_doc_id,
  };
}

async function readSourceText(fx: Fixtures, yjsDocId: string): Promise<string> {
  const loaded = await loadDoc({ db: fx.db, blobs: fx.blobs }, yjsDocId);
  const text = loaded.doc.getText('source').toString();
  loaded.doc.destroy();
  return text;
}

describe('project-wide checkpoints', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('POST creates a project checkpoint covering every text file', async () => {
    const p = await freshProject(fx);
    const res = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'before big edit' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project_checkpoint: {
        id: string;
        label: string;
        files: Array<{ path: string }>;
      };
    };
    expect(body.project_checkpoint.label).toBe('before big edit');
    const paths = body.project_checkpoint.files.map((f) => f.path).sort();
    expect(paths).toEqual(['chapters/intro.tex', 'main.tex']);
  });

  it('GET lists project checkpoints with file_count', async () => {
    const p = await freshProject(fx);
    await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'snap A' }),
    });
    const res = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      headers: { cookie: p.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project_checkpoints: Array<{ label: string; file_count: number; blob_count: number }>;
    };
    expect(body.project_checkpoints).toHaveLength(1);
    expect(body.project_checkpoints[0].label).toBe('snap A');
    expect(body.project_checkpoints[0].file_count).toBe(2);
    // No blobs in this project; counts default to 0.
    expect(body.project_checkpoints[0].blob_count).toBe(0);
  });

  it('per-file /checkpoints listing hides project-checkpoint members', async () => {
    const p = await freshProject(fx);
    // Create one project checkpoint (writes 2 doc_checkpoints rows)
    // and one stand-alone per-file checkpoint of main.tex.
    await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'project A' }),
    });
    await fetch(`${fx.baseUrl}/api/docs/${p.docId}/checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'main only' }),
    });

    const list = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/checkpoints`, {
      headers: { cookie: p.cookie },
    });
    const body = (await list.json()) as {
      checkpoints: Array<{ label: string }>;
    };
    expect(body.checkpoints.map((c) => c.label).sort()).toEqual(['main only']);
  });

  it('restore applies every file snapshot back to its live Yjs doc', async () => {
    const p = await freshProject(fx);
    // Snapshot @ v1.
    const cp = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'v1 snapshot' }),
    });
    const { project_checkpoint: project } = (await cp.json()) as {
      project_checkpoint: { id: string };
    };

    // Mutate both files to v2.
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    for (const [yjsDocId, text] of [
      [p.docId, 'MAIN v2 destructive'],
      [p.introYjsDocId, 'INTRO v2 destructive'],
    ] as const) {
      const y = new Y.Doc();
      Y.applyUpdate(y, Y.encodeStateAsUpdate((await loadDoc(crdtDeps, yjsDocId)).doc));
      const t = y.getText('source');
      t.delete(0, t.length);
      t.insert(0, text);
      await persistUpdate(crdtDeps, yjsDocId, 1n, Y.encodeStateAsUpdate(y), null);
      y.destroy();
    }

    // Restore.
    const restore = await fetch(
      `${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints/${project.id}/restore`,
      { method: 'POST', headers: { cookie: p.cookie } },
    );
    expect(restore.status).toBe(200);
    const body = (await restore.json()) as {
      restored: boolean;
      files_restored: number;
      blobs_restored: number;
      blobs_missing: string[];
      blob_state_preserved: boolean;
    };
    expect(body.restored).toBe(true);
    expect(body.files_restored).toBe(2);
    // blob_state_preserved flipped to true once we capture +
    // restore the blob set; this project has no blobs so 0 restored
    // and 0 missing.
    expect(body.blob_state_preserved).toBe(true);
    expect(body.blobs_restored).toBe(0);
    expect(body.blobs_missing).toEqual([]);

    expect(await readSourceText(fx, p.docId)).toBe('MAIN v1');
    expect(await readSourceText(fx, p.introYjsDocId)).toBe('INTRO v1');
  });

  it('DELETE drops the project checkpoint and cascades the per-file rows', async () => {
    const p = await freshProject(fx);
    const cp = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'gone' }),
    });
    const { project_checkpoint: project } = (await cp.json()) as {
      project_checkpoint: { id: string };
    };

    const del = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints/${project.id}`, {
      method: 'DELETE',
      headers: { cookie: p.cookie },
    });
    expect(del.status).toBe(204);

    const list = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      headers: { cookie: p.cookie },
    });
    const body = (await list.json()) as {
      project_checkpoints: Array<unknown>;
    };
    expect(body.project_checkpoints).toHaveLength(0);
  });

  it('captures + restores the blob set; subsequent asset DELETE keeps the S3 object pinned', async () => {
    const p = await freshProject(fx);

    // Upload a blob via the file-upload endpoint so the doc_files
    // row + S3 object both exist before the checkpoint.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      'base64',
    );
    {
      const fd = new FormData();
      fd.append('path', 'images/dot.png');
      fd.append('file', new File([new Uint8Array(png)], 'dot.png', { type: 'image/png' }));
      const res = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/files/upload`, {
        method: 'POST',
        headers: { cookie: p.cookie },
        body: fd,
      });
      expect(res.status).toBe(201);
    }

    // Project checkpoint — captures both text files AND the blob.
    const cp = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'before drop' }),
    });
    const cpBody = (await cp.json()) as {
      project_checkpoint: {
        id: string;
        blobs: Array<{ path: string }>;
      };
    };
    expect(cpBody.project_checkpoint.blobs.map((b) => b.path)).toEqual(['images/dot.png']);

    // Find the live blob id and DELETE it. The S3 object MUST stay
    // because the project checkpoint references it.
    const filesList = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/files`, {
      headers: { cookie: p.cookie },
    });
    const filesBody = (await filesList.json()) as {
      files: Array<{ id: string; path: string; kind: string }>;
    };
    const blobFile = filesBody.files.find((f) => f.path === 'images/dot.png');
    expect(blobFile).toBeDefined();

    const del = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/files/${blobFile!.id}`, {
      method: 'DELETE',
      headers: { cookie: p.cookie },
    });
    expect(del.status).toBe(204);

    // Confirm the doc_files row is gone but the S3 object survived.
    const stillThere = await fx.blobs.size();
    expect(stillThere).toBeGreaterThan(0);

    // Restore the project checkpoint. The blob set should reappear
    // pointing at the same S3 object (no re-upload needed).
    const restore = await fetch(
      `${fx.baseUrl}/api/docs/${p.docId}/project-checkpoints/${cpBody.project_checkpoint.id}/restore`,
      { method: 'POST', headers: { cookie: p.cookie } },
    );
    expect(restore.status).toBe(200);
    const restoreBody = (await restore.json()) as {
      blob_state_preserved: boolean;
      blobs_restored: number;
      blobs_missing: string[];
    };
    expect(restoreBody.blob_state_preserved).toBe(true);
    expect(restoreBody.blobs_restored).toBe(1);
    expect(restoreBody.blobs_missing).toEqual([]);

    // doc_files row reappears at images/dot.png.
    const after = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/files`, {
      headers: { cookie: p.cookie },
    });
    const afterBody = (await after.json()) as {
      files: Array<{ path: string; kind: string }>;
    };
    expect(afterBody.files.find((f) => f.path === 'images/dot.png')?.kind).toBe('blob');
  });
});
