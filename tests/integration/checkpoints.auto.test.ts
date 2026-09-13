import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import {
  docCheckpoints,
  docCollaborators,
  docFiles,
  docs,
  users,
  db as makeDb,
  type Database,
} from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

const PUBLIC_BASE_URL = 'http://localhost:5173';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  blobs: MemoryBlobStore;
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
  const blobs = new MemoryBlobStore();
  const app = await buildServer({
    db,
    blobs,
    cookieSecret: 'auto-checkpoint-secret',
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
    blobs,
    dbPool: pool,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function cookieFor(baseUrl: string, userId: string): Promise<string> {
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
  aliceEmail: string;
  bobId: string;
  bobEmail: string;
  carolId: string; // viewer
  docId: string;
  yjsDocId: string;
}

async function seed(fx: Fixtures): Promise<Seeds> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const mk = async (label: string, isAdmin: boolean): Promise<{ id: string; email: string }> => {
    const [row] = await fx.db
      .insert(users)
      .values({
        email: `${label}-${suffix}@example.com`,
        name: label,
        isAdmin,
      })
      .returning({ id: users.id, email: users.email });
    return row;
  };
  const alice = await mk('alice', false);
  const bob = await mk('bob', false);
  const carol = await mk('carol', false);
  const [doc] = await fx.db
    .insert(docs)
    .values({ title: 'Auto-checkpoint Test', engine: 'latex', ownerId: alice.id })
    .returning({ id: docs.id });
  await fx.db.insert(docCollaborators).values([
    { docId: doc.id, userId: bob.id, role: 'editor' },
    { docId: doc.id, userId: carol.id, role: 'viewer' },
  ]);
  // The doc-create REST route writes doc_files; here we insert the
  // schema directly so look up the main file row to feed the
  // ?fileId= query later.
  await fx.db.insert(docFiles).values({
    docId: doc.id,
    path: 'main.tex',
    kind: 'text',
    yjsDocId: doc.id,
  });
  return {
    aliceId: alice.id,
    aliceEmail: alice.email,
    bobId: bob.id,
    bobEmail: bob.email,
    carolId: carol.id,
    docId: doc.id,
    yjsDocId: doc.id,
  };
}

async function call(
  fx: Fixtures,
  userId: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (userId) headers.cookie = await cookieFor(fx.baseUrl, userId);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${fx.baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('auto-checkpoint on file open', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('creates an auto_open snapshot with a "Opened by <email>" label and kind=auto_open', async () => {
    const s = await seed(fx);
    const res = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, {
      auto: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      checkpoint: { kind: string; label: string };
    };
    expect(body.checkpoint.kind).toBe('auto_open');
    expect(body.checkpoint.label).toBe(`Opened by ${s.aliceEmail}`);
  });

  it('coalesces back-to-back auto requests for the same user+file (5-min window)', async () => {
    const s = await seed(fx);
    const r1 = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, {
      auto: true,
    });
    expect(r1.status).toBe(201);
    const r2 = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, {
      auto: true,
    });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { skipped: boolean; reason: string };
    expect(body).toEqual({ skipped: true, reason: 'coalesced' });

    // DB should only have one auto_open row for alice on this file.
    const rows = await fx.db
      .select({ id: docCheckpoints.id })
      .from(docCheckpoints)
      .where(eq(docCheckpoints.yjsDocId, s.yjsDocId));
    expect(rows).toHaveLength(1);
  });

  it('does NOT coalesce across different users — bob and alice each get their own', async () => {
    const s = await seed(fx);
    const a = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, {
      auto: true,
    });
    expect(a.status).toBe(201);
    const b = await call(fx, s.bobId, 'POST', `/docs/${s.docId}/checkpoints`, {
      auto: true,
    });
    expect(b.status).toBe(201);

    const list = await call(fx, s.aliceId, 'GET', `/docs/${s.docId}/checkpoints`);
    const body = (await list.json()) as {
      checkpoints: Array<{ kind: string; label: string; created_by_email: string | null }>;
    };
    const auto = body.checkpoints.filter((c) => c.kind === 'auto_open');
    expect(auto).toHaveLength(2);
    const labels = auto.map((c) => c.label).sort();
    expect(labels).toEqual([`Opened by ${s.aliceEmail}`, `Opened by ${s.bobEmail}`]);
    // created_by_email should be threaded out for the panel.
    expect(auto[0].created_by_email).toBeTruthy();
  });

  it('viewer cannot fire auto-checkpoint (assertCanWrite blocks them)', async () => {
    const s = await seed(fx);
    const res = await call(fx, s.carolId, 'POST', `/docs/${s.docId}/checkpoints`, {
      auto: true,
    });
    expect(res.status).toBe(403);
  });

  it('archived doc rejects auto-checkpoint with 422 archived', async () => {
    const s = await seed(fx);
    await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/archive`);
    const res = await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, {
      auto: true,
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'archived',
    });
  });

  it('GET /checkpoints sweeps auto_open older than 30 days as a side effect', async () => {
    const s = await seed(fx);
    // Plant a fresh auto_open row, then back-date it past the 30-day
    // retention window so the sweep should pick it up on the next
    // list call.
    await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, { auto: true });
    await fx.db
      .update(docCheckpoints)
      .set({ createdAt: sql`now() - interval '40 days'` })
      .where(eq(docCheckpoints.yjsDocId, s.yjsDocId));
    // Confirm the row is in place before we sweep.
    const before = await fx.db
      .select({ id: docCheckpoints.id, snapshotKey: docCheckpoints.snapshotKey })
      .from(docCheckpoints)
      .where(eq(docCheckpoints.yjsDocId, s.yjsDocId));
    expect(before).toHaveLength(1);
    const blobKey = before[0].snapshotKey;
    expect(await fx.blobs.get(blobKey)).not.toBeNull();

    // List → sweep fires.
    await call(fx, s.aliceId, 'GET', `/docs/${s.docId}/checkpoints`);

    const after = await fx.db
      .select({ id: docCheckpoints.id })
      .from(docCheckpoints)
      .where(eq(docCheckpoints.yjsDocId, s.yjsDocId));
    expect(after).toHaveLength(0);
    // S3 blob is reaped alongside the row.
    expect(await fx.blobs.get(blobKey)).toBeNull();
  });

  it('user-named checkpoints are NOT pruned by the auto retention sweep', async () => {
    const s = await seed(fx);
    await call(fx, s.aliceId, 'POST', `/docs/${s.docId}/checkpoints`, {
      label: 'Manual milestone',
    });
    // Back-date the user-named row to 90 days. The sweep targets
    // kind='auto_open' only — this row must survive.
    await fx.db
      .update(docCheckpoints)
      .set({ createdAt: sql`now() - interval '90 days'` })
      .where(eq(docCheckpoints.yjsDocId, s.yjsDocId));

    await call(fx, s.aliceId, 'GET', `/docs/${s.docId}/checkpoints`);
    const survivors = await fx.db
      .select({ id: docCheckpoints.id, kind: docCheckpoints.kind })
      .from(docCheckpoints)
      .where(eq(docCheckpoints.yjsDocId, s.yjsDocId));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].kind).toBe('user');
  });
});
