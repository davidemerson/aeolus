import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
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
    cookieSecret: 'blob-gc-test-secret',
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

async function adminCookie(fx: Fixtures): Promise<string> {
  const u = await fx.db
    .insert(await import('@aeolus/db').then((m) => m.users))
    .values({
      email: `gc-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
      isAdmin: true,
    })
    .returning({ id: (await import('@aeolus/db')).users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: u[0].id }),
  });
  const sc = sess.headers.get('set-cookie');
  const p = parseSetCookie(sc!);
  return `${p!.name}=${p!.value}`;
}

describe('blob GC sweep', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('admin-only: 401 for anonymous, 403 for non-admin', async () => {
    const anon = await fetch(`${fx.baseUrl}/api/admin/blob-gc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(anon.status).toBe(401);

    // Non-admin user.
    const u = await fx.db
      .insert(await import('@aeolus/db').then((m) => m.users))
      .values({
        email: `gc-user-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
        isAdmin: false,
      })
      .returning({ id: (await import('@aeolus/db')).users.id });
    const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: u[0].id }),
    });
    const sc = sess.headers.get('set-cookie');
    const p = parseSetCookie(sc!);
    const userCookie = `${p!.name}=${p!.value}`;
    const denied = await fetch(`${fx.baseUrl}/api/admin/blob-gc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: userCookie },
      body: '{}',
    });
    expect(denied.status).toBe(403);
  });

  it('dry_run reports orphans without deleting; non-dry deletes them', async () => {
    const cookie = await adminCookie(fx);

    // Seed an actual asset via the file-upload API so the
    // referenced storage_key shape is realistic.
    const create = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'gc target', engine: 'latex' }),
    });
    const { id: docId } = (await create.json()) as { id: string };

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      'base64',
    );
    const fd = new FormData();
    fd.append('path', 'images/x.png');
    fd.append('file', new File([new Uint8Array(png)], 'x.png', { type: 'image/png' }));
    const upload = await fetch(`${fx.baseUrl}/api/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(upload.status).toBe(201);

    // Drop a deliberate orphan straight into the blob store.
    await fx.blobs.put('assets/ghost-doc/ghost.bin', Buffer.from('orphan'));
    await fx.blobs.put('assets/ghost-doc/ghost2.bin', Buffer.from('also orphan'));

    // Dry run.
    const dry = await fetch(`${fx.baseUrl}/api/admin/blob-gc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(dry.status).toBe(200);
    const dryBody = (await dry.json()) as {
      dry_run: boolean;
      scanned: number;
      referenced: number;
      orphan_count: number;
      bytes_freed: number;
      orphans_sample: Array<{ key: string }>;
    };
    expect(dryBody.dry_run).toBe(true);
    expect(dryBody.orphan_count).toBe(2);
    expect(dryBody.bytes_freed).toBe(0);
    const orphanKeys = dryBody.orphans_sample.map((o) => o.key).sort();
    expect(orphanKeys).toEqual(['assets/ghost-doc/ghost.bin', 'assets/ghost-doc/ghost2.bin']);
    // The legitimate upload's storage_key is NOT in the orphan
    // listing (it's in doc_files).
    expect(orphanKeys.find((k) => k.startsWith(`assets/${docId}/`))).toBeUndefined();
    // Both orphans still in S3 after dry run.
    expect(await fx.blobs.get('assets/ghost-doc/ghost.bin')).not.toBeNull();

    // For-real run.
    const live = await fetch(`${fx.baseUrl}/api/admin/blob-gc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: false }),
    });
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as {
      orphan_count: number;
      bytes_freed: number;
    };
    expect(liveBody.orphan_count).toBe(2);
    expect(liveBody.bytes_freed).toBeGreaterThan(0);

    // Orphans gone, real upload survives.
    expect(await fx.blobs.get('assets/ghost-doc/ghost.bin')).toBeNull();
    expect(await fx.blobs.get('assets/ghost-doc/ghost2.bin')).toBeNull();
    // Find the survivor's key from doc_files.
    const { docFiles } = await import('@aeolus/db');
    const { eq, and } = await import('drizzle-orm');
    const [survivor] = await fx.db
      .select({ storageKey: docFiles.storageKey })
      .from(docFiles)
      .where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'blob')));
    expect(await fx.blobs.get(survivor.storageKey!)).not.toBeNull();
  });

  it('preserves blobs pinned by a project checkpoint even after asset deletion', async () => {
    const cookie = await adminCookie(fx);
    const create = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'pin doc', engine: 'latex' }),
    });
    const { id: docId } = (await create.json()) as { id: string };

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      'base64',
    );
    const fd = new FormData();
    fd.append('path', 'pinned.png');
    fd.append('file', new File([new Uint8Array(png)], 'pinned.png', { type: 'image/png' }));
    const upload = await fetch(`${fx.baseUrl}/api/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    const uploaded = (await upload.json()) as { file: { id: string } };

    // Pin via project checkpoint.
    await fetch(`${fx.baseUrl}/api/docs/${docId}/project-checkpoints`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'pin' }),
    });

    // Delete the asset. The S3 object survives (the asset DELETE
    // path checks doc_project_checkpoint_blobs.storage_key).
    const del = await fetch(`${fx.baseUrl}/api/docs/${docId}/files/${uploaded.file.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(204);

    // GC sweep — the pinned object should be classified as
    // referenced (via doc_project_checkpoint_blobs), not orphaned.
    const res = await fetch(`${fx.baseUrl}/api/admin/blob-gc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });
    const body = (await res.json()) as {
      orphans_sample: Array<{ key: string }>;
    };
    // No orphan should reference this doc's asset prefix.
    const docOrphans = body.orphans_sample.filter((o) => o.key.startsWith(`assets/${docId}/`));
    expect(docOrphans).toEqual([]);
  });

  it('respects the prefix filter so a partial sweep can target one path', async () => {
    const cookie = await adminCookie(fx);
    await fx.blobs.put('assets/dir-a/orphan.bin', Buffer.from('a'));
    await fx.blobs.put('assets/dir-b/orphan.bin', Buffer.from('b'));

    const res = await fetch(`${fx.baseUrl}/api/admin/blob-gc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true, prefix: 'assets/dir-a/' }),
    });
    const body = (await res.json()) as {
      scanned: number;
      orphans_sample: Array<{ key: string }>;
    };
    // Scan was limited to the prefix.
    expect(body.orphans_sample.every((o) => o.key.startsWith('assets/dir-a/'))).toBe(true);
    // dir-b orphan was NOT touched (out of prefix).
    expect(await fx.blobs.get('assets/dir-b/orphan.bin')).not.toBeNull();
  });
});
