import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import {
  aiQuota,
  aiRequests,
  auditEvents,
  db as makeDb,
  docs,
  users,
  type Database,
} from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';
import { waitFor as poll } from './helpers/poll.js';

/**
 * `/api/v1/ai/assist` — the plane's one streaming operation.
 *
 * What is worth pinning here is the seam, not the model: a failure the server
 * can see BEFORE the first byte is an HTTP status, and a failure after it can
 * only be an `error` event on a response that already returned 200. A client
 * that conflates the two reports a failed generation as an empty one.
 */

/** A minimal Anthropic messages endpoint that streams one text delta. */
function mockAnthropic(): { server: http.Server; setFailing: (v: boolean) => void } {
  // A toggle rather than a one-shot: the Anthropic SDK retries a 5xx, so a
  // fail-once mock just makes the second attempt succeed.
  let fail = false;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      res.writeHead(404).end('{}');
      return;
    }
    req.resume();
    req.on('end', () => {
      if (fail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'upstream exploded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t: string, d: unknown) =>
        res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 50,
            output_tokens: 0,
            cache_creation_input_tokens: 350,
            cache_read_input_tokens: 0,
          },
        },
      });
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Improved text.' },
      });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 25 },
      });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return { server, setFailing: (v: boolean) => (fail = v) };
}

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  setFailing: (v: boolean) => void;
  close(): Promise<void>;
}

let fx: Fixtures;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_test')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();
  await runMigrations(postgres.getConnectionUri());
  const { db, pool } = makeDb({ connectionString: postgres.getConnectionUri() });

  const { server: mock, setFailing } = mockAnthropic();
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_API_KEY = 'test-mock-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'v1-assist-test-secret',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
    enableDevRoutes: true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  fx = {
    postgres,
    baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    db,
    setFailing,
    async close() {
      await app.close();
      mock.close();
      await pool.end();
      await postgres.stop();
    },
  };
}, 180_000);

afterAll(async () => {
  await fx?.close();
});

let seq = 0;
async function persona() {
  const email = `v1ai-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email }).returning({ id: users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
  const cookie = `${c.name}=${c.value}`;
  const mint = async (scope: 'read' | 'write') => {
    const res = await fetch(`${fx.baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: `${scope}-${seq}`, scope }),
    });
    return ((await res.json()) as { token: string }).token;
  };
  const [doc] = await fx.db
    .insert(docs)
    .values({ title: 'assist target', engine: 'latex', ownerId: user.id })
    .returning({ id: docs.id });
  return { userId: user.id, docId: doc.id, read: await mint('read'), write: await mint('write') };
}

function post(token: string, body: unknown) {
  return fetch(`${fx.baseUrl}/api/v1/ai/assist`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * The ledger and the audit row are written AFTER the stream is closed —
 * deliberately, so DB latency does not hold the response open past the last
 * chunk. A test that reads them the instant the body ends is racing the server,
 * so poll instead of sleeping on a guess.
 */
async function waitFor<T>(read: () => Promise<T[]>, what: string): Promise<T[]> {
  return poll(
    async () => {
      const rows = await read();
      return rows.length > 0 ? rows : null;
    },
    { label: what },
  );
}

/** Parse an SSE body into `[event, data]` pairs, dropping keepalive comments. */
function events(body: string): Array<[string, Record<string, unknown>]> {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const name = /^event: (.+)$/m.exec(block)![1];
      const data = /^data: (.+)$/m.exec(block)![1];
      return [name, JSON.parse(data) as Record<string, unknown>];
    });
}

describe('POST /api/v1/ai/assist', () => {
  it('streams chunk → usage → done, as text/event-stream', async () => {
    const me = await persona();
    const res = await post(me.write, {
      doc_id: me.docId,
      selection: 'The quick brown fox.',
      instruction: 'improve',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const seen = events(await res.text());
    expect(seen.map(([name]) => name)).toEqual(['chunk', 'usage', 'done']);
    expect(seen[0][1].text).toBe('Improved text.');
    expect(seen[1][1]).toMatchObject({ usage: { output_tokens: 25 } });
  });

  it("bills the token's user and records that a machine asked", async () => {
    const me = await persona();
    await (
      await post(me.write, { doc_id: me.docId, selection: 'x', instruction: 'improve' })
    ).text();

    const [ledger] = await waitFor(
      () => fx.db.select().from(aiRequests).where(eq(aiRequests.userId, me.userId)),
      'the ai_requests ledger row',
    );
    expect(ledger.status).toBe('success');
    // 50 in + 350 cache-write + 25 out, at list price, rounded up.
    expect(ledger.costUsdCents).toBeGreaterThan(0);
    expect(ledger.docId).toBe(me.docId);

    // The ledger says what it cost; the audit trail says a token asked. Neither
    // alone answers "what did automation spend".
    const [event] = await waitFor(
      () =>
        fx.db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.action, 'ai.assist'), eq(auditEvents.resourceId, me.docId))),
      'the ai.assist audit event',
    );
    expect(event.metadata).toMatchObject({ via: 'api_token', status: 'success' });
  });

  it('reports an upstream failure as an `error` EVENT on a 200, not a status', async () => {
    const me = await persona();
    fx.setFailing(true);
    let seen: Array<[string, Record<string, unknown>]>;
    let status: number;
    try {
      const res = await post(me.write, {
        doc_id: me.docId,
        selection: 'x',
        instruction: 'improve',
      });
      status = res.status;
      seen = events(await res.text());
    } finally {
      fx.setFailing(false);
    }

    // The preflight passed, so the status line was already committed. This is
    // the case a client that trusts `res.ok` silently mis-reports.
    expect(status).toBe(200);
    expect(seen.map(([name]) => name)).toEqual(['error']);
    expect(String(seen[0][1].error)).toMatch(/./);

    // Nothing was billed: no usage arrived before the failure.
    expect(await fx.db.select().from(aiRequests).where(eq(aiRequests.userId, me.userId))).toEqual(
      [],
    );
  });

  it('refuses a read-scope token before any stream opens', async () => {
    const me = await persona();
    const res = await post(me.read, { doc_id: me.docId, selection: 'x', instruction: 'improve' });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()) as unknown).toMatchObject({ error: 'read_only_token' });
  });

  it("404s a document the token's user cannot read, as JSON", async () => {
    const me = await persona();
    const other = await persona();
    const res = await post(me.write, {
      doc_id: other.docId,
      selection: 'x',
      instruction: 'improve',
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('400s a malformed body', async () => {
    const me = await persona();
    const res = await post(me.write, { doc_id: me.docId, instruction: 'improve' });
    expect(res.status).toBe(400);
  });

  it("spends the MINTING USER's quota, and 429s with quota_exceeded when it is gone", async () => {
    const me = await persona();
    // Not the plane's 120/min rate limit — the per-user assist allowance, which
    // is why a token needs no spend control of its own.
    await fx.db.insert(aiQuota).values({ userId: me.userId, perHour: 0 });

    const res = await post(me.write, { doc_id: me.docId, selection: 'x', instruction: 'improve' });
    expect(res.status).toBe(429);
    expect((await res.json()) as unknown).toMatchObject({ error: 'quota_exceeded' });

    // And the quota route reports the same ceiling to the same token.
    const quota = await fetch(`${fx.baseUrl}/api/v1/ai/quota`, {
      headers: { authorization: `Bearer ${me.read}` },
    });
    expect((await quota.json()) as unknown).toMatchObject({ hourly: { limit: 0 } });
  });

  it('503s ai_unavailable when no key is configured', async () => {
    const me = await persona();
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await post(me.write, {
        doc_id: me.docId,
        selection: 'x',
        instruction: 'improve',
      });
      expect(res.status).toBe(503);
      expect((await res.json()) as unknown).toMatchObject({ error: 'ai_unavailable' });
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
    }
  });
});
