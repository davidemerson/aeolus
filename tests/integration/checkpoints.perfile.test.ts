import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { MemoryBlobStore, persistUpdate, type CrdtDeps } from '@aeolus/crdt';
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
    cookieSecret: 'cp-perfile-test-secret',
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
      email: `cp-pf-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
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
    body: JSON.stringify({ title: 'Per-file CP', engine: 'latex' }),
  });
  const { id: docId } = (await create.json()) as { id: string };

  // Create a second text file. The API mints a synthetic yjs_doc_id;
  // capture it for direct content seeding via persistUpdate.
  const introCreate = await fetch(`${fx.baseUrl}/api/docs/${docId}/files`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'chapters/intro.tex' }),
  });
  const { file: intro } = (await introCreate.json()) as {
    file: { id: string; yjs_doc_id: string };
  };

  // Seed distinct content on the two yjs_doc_ids so checkpoint
  // payloads differ between files.
  const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
  {
    const y = new Y.Doc();
    y.getText('source').insert(0, 'MAIN BODY');
    await persistUpdate(crdtDeps, docId, 0n, Y.encodeStateAsUpdate(y), null);
    y.destroy();
  }
  {
    const y = new Y.Doc();
    y.getText('source').insert(0, 'INTRO BODY');
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

describe('per-file checkpoints — issue #9 follow-up', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('POST /checkpoints with no fileId scopes to the main file', async () => {
    const p = await freshProject(fx);
    const res = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'main snap' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      checkpoint: { file_path: string };
    };
    expect(body.checkpoint.file_path).toBe('main.tex');
  });

  it('POST /checkpoints with ?fileId targets that file', async () => {
    const p = await freshProject(fx);
    const res = await fetch(
      `${fx.baseUrl}/api/docs/${p.docId}/checkpoints?fileId=${p.introFileId}`,
      {
        method: 'POST',
        headers: { cookie: p.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'intro snap' }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      checkpoint: { file_path: string };
    };
    expect(body.checkpoint.file_path).toBe('chapters/intro.tex');
  });

  it('GET /checkpoints lists per-file with isolation', async () => {
    const p = await freshProject(fx);
    // Create one of each.
    await fetch(`${fx.baseUrl}/api/docs/${p.docId}/checkpoints`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'main A' }),
    });
    await fetch(`${fx.baseUrl}/api/docs/${p.docId}/checkpoints?fileId=${p.introFileId}`, {
      method: 'POST',
      headers: { cookie: p.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'intro A' }),
    });

    const mainList = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/checkpoints`, {
      headers: { cookie: p.cookie },
    });
    const mainBody = (await mainList.json()) as {
      checkpoints: Array<{ label: string; file_path: string }>;
    };
    expect(mainBody.checkpoints.map((c) => c.label).sort()).toEqual(['main A']);
    expect(mainBody.checkpoints[0].file_path).toBe('main.tex');

    const introList = await fetch(
      `${fx.baseUrl}/api/docs/${p.docId}/checkpoints?fileId=${p.introFileId}`,
      { headers: { cookie: p.cookie } },
    );
    const introBody = (await introList.json()) as {
      checkpoints: Array<{ label: string; file_path: string }>;
    };
    expect(introBody.checkpoints.map((c) => c.label).sort()).toEqual(['intro A']);
    expect(introBody.checkpoints[0].file_path).toBe('chapters/intro.tex');
  });

  it('POST .../restore restores INTO the file the checkpoint belongs to', async () => {
    const p = await freshProject(fx);
    // Create a checkpoint of intro.tex while it has "INTRO BODY".
    const cp = await fetch(
      `${fx.baseUrl}/api/docs/${p.docId}/checkpoints?fileId=${p.introFileId}`,
      {
        method: 'POST',
        headers: { cookie: p.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'intro v1' }),
      },
    );
    const { checkpoint } = (await cp.json()) as { checkpoint: { id: string } };

    // Mutate intro to "INTRO BODY destructive".
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    {
      const y = new Y.Doc();
      Y.applyUpdate(y, await loadYjsBytes(fx, p.introYjsDocId));
      y.getText('source').insert(y.getText('source').length, ' destructive');
      await persistUpdate(crdtDeps, p.introYjsDocId, 1n, Y.encodeStateAsUpdate(y), null);
      y.destroy();
    }

    // Restore.
    const restore = await fetch(
      `${fx.baseUrl}/api/docs/${p.docId}/checkpoints/${checkpoint.id}/restore`,
      { method: 'POST', headers: { cookie: p.cookie } },
    );
    expect(restore.status).toBe(200);
    const restoreBody = (await restore.json()) as {
      restored: boolean;
      file_path: string;
    };
    expect(restoreBody.restored).toBe(true);
    expect(restoreBody.file_path).toBe('chapters/intro.tex');

    // Confirm the live intro Yjs doc reads back as "INTRO BODY".
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, await loadYjsBytes(fx, p.introYjsDocId));
    expect(ydoc.getText('source').toString()).toBe('INTRO BODY');
    ydoc.destroy();
  });

  it('GET single checkpoint includes file_path; cross-doc lookup 404s', async () => {
    const p = await freshProject(fx);
    const cp = await fetch(
      `${fx.baseUrl}/api/docs/${p.docId}/checkpoints?fileId=${p.introFileId}`,
      {
        method: 'POST',
        headers: { cookie: p.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'pinned' }),
      },
    );
    const { checkpoint } = (await cp.json()) as { checkpoint: { id: string } };

    const ok = await fetch(`${fx.baseUrl}/api/docs/${p.docId}/checkpoints/${checkpoint.id}`, {
      headers: { cookie: p.cookie },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { checkpoint: { file_path: string } };
    expect(body.checkpoint.file_path).toBe('chapters/intro.tex');

    // Lookup against a fabricated doc id 404s.
    const notFound = await fetch(
      `${fx.baseUrl}/api/docs/${randomUUID()}/checkpoints/${checkpoint.id}`,
      { headers: { cookie: p.cookie } },
    );
    expect(notFound.status).toBe(404);
  });
});

// Replays every doc_updates row for a yjs_doc_id and returns the
// fully-encoded state. Avoids importing loadDoc (which needs
// CrdtDeps + a blob store) just to read the Y.Doc back.
async function loadYjsBytes(fx: Fixtures, yjsDocId: string): Promise<Uint8Array> {
  // Build via the repo-shared loadDoc helper to keep behavior in
  // lockstep with the worker.
  const { loadDoc } = await import('@aeolus/crdt');
  const loaded = await loadDoc({ db: fx.db, blobs: fx.blobs }, yjsDocId);
  const out = Y.encodeStateAsUpdate(loaded.doc);
  loaded.doc.destroy();
  return out;
}
