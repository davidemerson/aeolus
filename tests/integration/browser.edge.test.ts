import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import type { FastifyInstance } from 'fastify';

// The browser plane's edge (ADR 0025): per-route rate limits on the four
// routes that had none, the CSP report sink, and Fastify's own error codes
// mapped to the house envelope. Sign-out lives in me.session.test.ts.

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('browser-plane edge', () => {
  let postgres: StartedPostgreSqlContainer;
  let app: FastifyInstance;
  let baseUrl: string;
  let pool: ReturnType<typeof makeDb>['pool'];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
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
      blobs: new MemoryBlobStore(),
      cookieSecret: 'edge-test-secret',
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

  // The limiter runs before authentication, so an anonymous caller is the
  // simplest way to count: N-1 requests answer 401, the Nth answers 429.
  async function hammer(path: string, max: number): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
      expect(res.status, `request ${i + 1} of ${max}`).toBe(401);
      expect((await json(res)).error).toBe('unauthenticated');
    }
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
    expect(res.status).toBe(429);
    const body = await json<{ error: string; message: string }>(res);
    expect(body.error).toBe('rate_limited');
    expect(body.message).toMatch(/^Rate limit exceeded: \d+ requests per /);
    expect(res.headers.get('retry-after')).toBeTruthy();
  }

  it('rate-limits POST /api/ws/ticket (60/min) and says so in the house envelope', async () => {
    await hammer('/api/ws/ticket', 60);
  });

  it('rate-limits POST /api/tokens (30/min)', async () => {
    await hammer('/api/tokens', 30);
  });

  it('rate-limits POST /api/ai/assist (30/min), which now answers 401 `unauthenticated` like every other route', async () => {
    await hammer('/api/ai/assist', 30);
  });

  it('accepts a CSP violation report and answers 204', async () => {
    const res = await fetch(`${baseUrl}/api/csp-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': {
          'document-uri': 'http://localhost:5173/docs/x',
          'effective-directive': 'script-src',
          'blocked-uri': 'https://evil.example/x.js',
        },
      }),
    });
    expect(res.status).toBe(204);
  });

  it("maps Fastify's body-too-large to 413 payload_too_large instead of leaking FST_ERR_*", async () => {
    const res = await fetch(`${baseUrl}/api/csp-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: 'x'.repeat(20 * 1024),
    });
    expect(res.status).toBe(413);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe('payload_too_large');
  });
});
