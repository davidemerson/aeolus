import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import type { FastifyInstance } from 'fastify';

// /readyz (ADR 0024): 200 only when Postgres answers and the blob store
// round-trips a probe object. The 503 half lives in healthz.test.ts, which
// boots against a database that does not exist.

describe('readyz', () => {
  let postgres: StartedPostgreSqlContainer;
  let app: FastifyInstance;
  let baseUrl: string;
  let pool: ReturnType<typeof makeDb>['pool'];
  const blobs = new MemoryBlobStore();

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('aeolus_test')
      .withUsername('aeolus')
      .withPassword('aeolus')
      .start();
    const connectionString = postgres.getConnectionUri();
    await runMigrations(connectionString);
    const created = makeDb({ connectionString });
    pool = created.pool;
    app = await buildServer({
      db: created.db,
      blobs,
      cookieSecret: 'readyz-test-secret',
      mail: new MemoryMailAdapter(),
      publicBaseUrl: 'http://localhost:5173',
      cookieSecure: false,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end().catch(() => undefined);
    await postgres?.stop();
  });

  it('answers 200 with both checks true, and wrote exactly one probe object', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: { db: boolean; blobs: boolean };
      checkedAt: string;
    };
    expect(body).toMatchObject({ ok: true, checks: { db: true, blobs: true } });
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
    const probes = (await blobs.list('_readyz/')).map((o) => o.key);
    expect(probes).toHaveLength(1);
  });

  it('serves the cached report on a second call without another probe write', async () => {
    const first = (await (await fetch(`${baseUrl}/readyz`)).json()) as { checkedAt: string };
    const second = (await (await fetch(`${baseUrl}/readyz`)).json()) as { checkedAt: string };
    expect(second.checkedAt).toBe(first.checkedAt);
    expect(await blobs.list('_readyz/')).toHaveLength(1);
  });
});
