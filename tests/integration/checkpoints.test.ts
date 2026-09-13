import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { loadDoc, MemoryBlobStore, persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { db as makeDb, docCheckpoints, docFiles, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { eq } from 'drizzle-orm';

import { parseSetCookie } from './helpers/cookies.js';

const COOKIE_SECRET = 'checkpoint-integration-test-secret';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: MemoryBlobStore;
  baseUrl: string;
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
    cookieSecret: COOKIE_SECRET,
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
    db,
    dbPool: pool,
    blobs,
    baseUrl,
    async close() {
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
  if (!setCookie) throw new Error('No set-cookie returned');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('Failed to parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

function writeYjsText(doc: Y.Doc, text: string): Uint8Array {
  const ytext = doc.getText('source');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  });
  return Y.encodeStateAsUpdate(doc);
}

describe('checkpoints', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('create -> edit -> restore -> diff-empty flow', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await fx.db
      .insert(users)
      .values({ email: `cp-owner-${suffix}@example.com`, name: 'Owner', isAdmin: false })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: `Checkpoint Test ${suffix}`, engine: 'latex', ownerId: owner.id })
      .returning({ id: docs.id });
    // Phase-3 dual-write: tests that bypass the API have to seed
    // the doc_files source row so the new yjs_doc_id FK target exists.
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });

    const cookie = await freshCookie(fx.baseUrl, owner.id);
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };

    // 1. Write "Version 1" via Yjs
    const ydoc = new Y.Doc();
    const update1 = writeYjsText(ydoc, 'Version 1');
    await persistUpdate(crdtDeps, doc.id, 1n, update1, owner.id);

    // 2. Create checkpoint A
    const cpARes = await fetch(`${fx.baseUrl}/api/docs/${doc.id}/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ label: 'Checkpoint A' }),
    });
    expect(cpARes.status).toBe(201);
    const cpA = (await cpARes.json()) as { checkpoint: { id: string } };

    // 3. Write "Version 2"
    const update2 = writeYjsText(ydoc, 'Version 2');
    await persistUpdate(crdtDeps, doc.id, 2n, update2, owner.id);

    // 4. Create checkpoint B
    const cpBRes = await fetch(`${fx.baseUrl}/api/docs/${doc.id}/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ label: 'Checkpoint B' }),
    });
    expect(cpBRes.status).toBe(201);
    const cpB = (await cpBRes.json()) as { checkpoint: { id: string } };

    // 5. Overwrite everything with "destructive edit"
    const update3 = writeYjsText(ydoc, 'destructive edit');
    await persistUpdate(crdtDeps, doc.id, 3n, update3, owner.id);

    // Verify current state is "destructive edit"
    const loaded1 = await loadDoc(crdtDeps, doc.id);
    expect(loaded1.doc.getText('source').toString()).toBe('destructive edit');
    loaded1.doc.destroy();

    // 6. List checkpoints (newest first)
    const listRes = await fetch(`${fx.baseUrl}/api/docs/${doc.id}/checkpoints`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      checkpoints: Array<{ id: string; label: string }>;
    };
    expect(listBody.checkpoints).toHaveLength(2);
    expect(listBody.checkpoints[0].label).toBe('Checkpoint B');
    expect(listBody.checkpoints[1].label).toBe('Checkpoint A');

    // 7. Get checkpoint A detail (has download_url)
    const detailRes = await fetch(
      `${fx.baseUrl}/api/docs/${doc.id}/checkpoints/${cpA.checkpoint.id}`,
      { headers: { cookie } },
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      checkpoint: { download_url: string; label: string };
    };
    expect(detail.checkpoint.label).toBe('Checkpoint A');
    expect(detail.checkpoint.download_url).toContain('/download');

    // 8. Download the checkpoint and verify content. Server returns
    // download_url relative to the api mount (`/docs/...`); consumers
    // prefix `/api` themselves — matches what the SPA does in
    // doc-editor.tsx's handlePreviewCheckpoint.
    const downloadRes = await fetch(`${fx.baseUrl}/api${detail.checkpoint.download_url}`, {
      headers: { cookie },
    });
    expect(downloadRes.status).toBe(200);
    const downloadBytes = new Uint8Array(await downloadRes.arrayBuffer());
    const previewDoc = new Y.Doc();
    Y.applyUpdate(previewDoc, downloadBytes);
    expect(previewDoc.getText('source').toString()).toBe('Version 1');
    previewDoc.destroy();

    // 9. Restore checkpoint A
    const restoreRes = await fetch(
      `${fx.baseUrl}/api/docs/${doc.id}/checkpoints/${cpA.checkpoint.id}/restore`,
      {
        method: 'POST',
        headers: { cookie },
      },
    );
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await restoreRes.json()) as { restored: boolean; rev: string };
    expect(restoreBody.restored).toBe(true);

    // 10. Assert live doc content == "Version 1"
    const loaded2 = await loadDoc(crdtDeps, doc.id);
    expect(loaded2.doc.getText('source').toString()).toBe('Version 1');
    loaded2.doc.destroy();

    // 11. Assert doc_checkpoints still has rows for A and B
    const cpRows = await fx.db
      .select({ id: docCheckpoints.id })
      .from(docCheckpoints)
      .where(eq(docCheckpoints.yjsDocId, doc.id));
    expect(cpRows).toHaveLength(2);
    const ids = cpRows.map((r) => r.id).sort();
    expect(ids).toContain(cpA.checkpoint.id);
    expect(ids).toContain(cpB.checkpoint.id);

    // 12. Assert restore ran as a new update (seq incremented, history continues)
    expect(BigInt(restoreBody.rev)).toBeGreaterThan(3n);

    ydoc.destroy();
  });

  it('rejects labels over 120 chars', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await fx.db
      .insert(users)
      .values({ email: `cp-long-${suffix}@example.com`, name: 'Owner', isAdmin: false })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: `Long Label Test ${suffix}`, engine: 'latex', ownerId: owner.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });
    const cookie = await freshCookie(fx.baseUrl, owner.id);

    const res = await fetch(`${fx.baseUrl}/api/docs/${doc.id}/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ label: 'x'.repeat(121) }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent checkpoint', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await fx.db
      .insert(users)
      .values({ email: `cp-404-${suffix}@example.com`, name: 'Owner', isAdmin: false })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: `404 Test ${suffix}`, engine: 'latex', ownerId: owner.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });
    const cookie = await freshCookie(fx.baseUrl, owner.id);

    const res = await fetch(
      `${fx.baseUrl}/api/docs/${doc.id}/checkpoints/00000000-0000-0000-0000-000000000000`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it('enforces ACL on checkpoint operations', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await fx.db
      .insert(users)
      .values({ email: `cp-acl-owner-${suffix}@example.com`, name: 'Owner', isAdmin: false })
      .returning({ id: users.id });
    const [outsider] = await fx.db
      .insert(users)
      .values({ email: `cp-acl-out-${suffix}@example.com`, name: 'Outsider', isAdmin: false })
      .returning({ id: users.id });
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: `ACL Test ${suffix}`, engine: 'latex', ownerId: owner.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });

    const outsiderCookie = await freshCookie(fx.baseUrl, outsider.id);

    const listRes = await fetch(`${fx.baseUrl}/api/docs/${doc.id}/checkpoints`, {
      headers: { cookie: outsiderCookie },
    });
    expect(listRes.status).toBe(404);

    const createRes = await fetch(`${fx.baseUrl}/api/docs/${doc.id}/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: outsiderCookie },
      body: JSON.stringify({ label: 'nope' }),
    });
    expect(createRes.status).toBe(404);
  });
});
