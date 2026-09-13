import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb } from '@aeolus/db';
import type { FastifyInstance } from 'fastify';

// /healthz must answer 200 even when the database isn't reachable.
// A load balancer's probe drains a target from the pool when the probe
// fails; if /healthz checked the DB transitively, a transient DB blip
// would cascade into the entire service going offline. The contract:
// 200 = "the process is up and serving HTTP". Readiness probes that
// touch downstream live at /readyz (ADR 0024) and are exercised below
// and in readyz.test.ts.

describe('healthz liveness', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let pool: ReturnType<typeof makeDb>['pool'];

  beforeAll(async () => {
    // Point at a database that does not exist and never will. The
    // server still has to boot, register routes, and answer /healthz.
    const { db, pool: createdPool } = makeDb({
      connectionString: 'postgres://aeolus:wrong@127.0.0.1:1/does-not-exist',
    });
    pool = createdPool;

    app = await buildServer({
      db,
      blobs: new MemoryBlobStore(),
      cookieSecret: 'liveness-test-secret',
      mail: new MemoryMailAdapter(),
      publicBaseUrl: 'http://localhost:5173',
      cookieSecure: false,
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end().catch(() => undefined);
  });

  it('answers 200 with {ok:true} even when the database is unreachable', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('/readyz answers 503 and names the failing dependency', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: { db: boolean; blobs: boolean } };
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe(false);
    // The in-memory blob store is fine; only the DB is down.
    expect(body.checks.blobs).toBe(true);
  });
});
