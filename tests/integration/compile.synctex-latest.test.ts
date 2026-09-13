import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { compileResults, docs, users, db as makeDb, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import type { FastifyInstance } from 'fastify';

import { parseSetCookie } from './helpers/cookies.js';

// GET /docs/:id/synctex/latest — the status contract.
//
// The editor fetches this on EVERY mount to restore PDF<->source jumps.
// "No sync map" is the normal state for a doc that has never compiled and
// the permanent state for every typst doc (typst emits no synctex), so it
// answers 204, not 404. As a 404 it meant every typst document logged a
// console error and a failed request on every page load — the kind of
// steady noise that trains people to ignore the console and buries real
// failures in an error tracker.
//
// 404 stays meaningful: unknown doc. 403 stays meaningful: no read access.
// This test exists to keep those three apart, because collapsing them back
// into one status is an easy and invisible regression.

const PUBLIC_BASE_URL = 'http://localhost:5173';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  app: FastifyInstance;
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
    cookieSecret: 'integration-test-secret-do-not-use',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: PUBLIC_BASE_URL,
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;

  return {
    postgres,
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    app,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function sessionCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev session failed: ${res.status}`);
  const parsed = parseSetCookie(res.headers.get('set-cookie') ?? '');
  if (!parsed) throw new Error('no set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

describe('GET /docs/:id/synctex/latest status contract', () => {
  let fx: Fixtures;
  let ownerCookie: string;
  let strangerCookie: string;
  let typstDocId: string;
  let latexDocId: string;

  beforeAll(async () => {
    fx = await setup();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await fx.db
      .insert(users)
      .values({ email: `owner-${suffix}@example.com`, name: 'owner', isAdmin: false })
      .returning({ id: users.id });
    const [stranger] = await fx.db
      .insert(users)
      .values({ email: `stranger-${suffix}@example.com`, name: 'stranger', isAdmin: false })
      .returning({ id: users.id });

    const [typstDoc] = await fx.db
      .insert(docs)
      .values({ title: 'Typst brief', engine: 'typst', ownerId: owner.id })
      .returning({ id: docs.id });
    const [latexDoc] = await fx.db
      .insert(docs)
      .values({ title: 'LaTeX paper', engine: 'latex', ownerId: owner.id })
      .returning({ id: docs.id });
    typstDocId = typstDoc.id;
    latexDocId = latexDoc.id;

    ownerCookie = await sessionCookie(fx.baseUrl, owner.id);
    strangerCookie = await sessionCookie(fx.baseUrl, stranger.id);
  }, 120_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('answers 204 with no body for a doc that has never compiled', async () => {
    const res = await fetch(`${fx.baseUrl}/api/docs/${latexDocId}/synctex/latest`, {
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  // The case that motivated the change: typst never produces a synctex
  // file, so this doc will answer the same way forever.
  it('answers 204 for a typst doc, which can never have a sync map', async () => {
    const res = await fetch(`${fx.baseUrl}/api/docs/${typstDocId}/synctex/latest`, {
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(204);
  });

  it('answers 204 when a successful compile produced no synctex key', async () => {
    await fx.db.insert(compileResults).values({
      docId: typstDocId,
      engine: 'typst',
      rev: 1n,
      jobId: '11111111-1111-4111-8111-111111111111',
      status: 'success',
      pdfKey: `compiled/${typstDocId}/1.pdf`,
      synctexKey: null,
      error: null,
    });
    const res = await fetch(`${fx.baseUrl}/api/docs/${typstDocId}/synctex/latest`, {
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(204);
  });

  // A row that names a blob which is gone (GC'd, or a restore that missed
  // it) is not a 404 either: there is no such sync map, which is exactly
  // what 204 says, and the editor's handling is identical.
  it('answers 204 when the synctex row points at a missing blob', async () => {
    await fx.db.insert(compileResults).values({
      docId: latexDocId,
      engine: 'latex',
      rev: 1n,
      jobId: '22222222-2222-4222-8222-222222222222',
      status: 'success',
      pdfKey: `compiled/${latexDocId}/1.pdf`,
      synctexKey: `compiled/${latexDocId}/1.synctex.json`,
      error: null,
    });
    const res = await fetch(`${fx.baseUrl}/api/docs/${latexDocId}/synctex/latest`, {
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(204);
  });

  it('still answers 404 for a doc that does not exist', async () => {
    const res = await fetch(
      `${fx.baseUrl}/api/docs/33333333-3333-4333-8333-333333333333/synctex/latest`,
      { headers: { cookie: ownerCookie } },
    );
    expect(res.status).toBe(404);
  });

  // A reader with no access must not be able to tell "exists but empty"
  // from "does not exist" — 204 would leak the doc's existence.
  it('does not answer 204 to someone with no read access', async () => {
    const res = await fetch(`${fx.baseUrl}/api/docs/${latexDocId}/synctex/latest`, {
      headers: { cookie: strangerCookie },
    });
    expect([403, 404]).toContain(res.status);
  });

  it('requires a session', async () => {
    const res = await fetch(`${fx.baseUrl}/api/docs/${latexDocId}/synctex/latest`);
    expect(res.status).toBe(401);
  });
});
