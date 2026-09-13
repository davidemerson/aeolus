import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { docs, users, db as makeDb, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

const PUBLIC_BASE_URL = 'http://localhost:5173';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  mockAnthropicUrl: string;
  mockServer: http.Server;
  getLastUserMessage: () => string | null;
  close(): Promise<void>;
}

function createMockAnthropicServer(): {
  server: http.Server;
  getRequestCount: () => number;
  getLastUserMessage: () => string | null;
} {
  let requestCount = 0;
  let systemPromptHash: string | null = null;
  let lastUserMessage: string | null = null;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requestCount++;

        const parsed = JSON.parse(body) as {
          system?: Array<{ text: string; cache_control?: { type: string } }>;
          messages?: Array<{ content: string }>;
        };
        lastUserMessage = parsed.messages?.[0]?.content ?? null;

        const systemBlocks = parsed.system ?? [];
        const hasCacheControl = systemBlocks.some((b) => b.cache_control?.type === 'ephemeral');

        if (!hasCacheControl) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'System prompt must include cache_control blocks',
              },
            }),
          );
          return;
        }

        const currentHash = systemBlocks.map((b) => b.text).join('|');
        const isRepeat = systemPromptHash === currentHash;
        systemPromptHash = currentHash;

        const cacheCreation = isRepeat ? 0 : 350;
        const cacheRead = isRepeat ? 350 : 0;
        const inputTokens = 50;
        const outputTokens = 25;

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        const messageId = `msg_mock_${requestCount}`;

        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: inputTokens,
                output_tokens: 0,
                cache_creation_input_tokens: cacheCreation,
                cache_read_input_tokens: cacheRead,
              },
            },
          })}\n\n`,
        );

        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`,
        );

        const responseText = 'Improved text from Claude.';
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: responseText },
          })}\n\n`,
        );

        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0,
          })}\n\n`,
        );

        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })}\n\n`,
        );

        res.write(
          `event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`,
        );

        res.end();
      });
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });

  return {
    server,
    getRequestCount: () => requestCount,
    getLastUserMessage: () => lastUserMessage,
  };
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

  const { server: mockServer, getLastUserMessage } = createMockAnthropicServer();
  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', resolve);
  });
  const mockAddress = mockServer.address() as AddressInfo;
  const mockAnthropicUrl = `http://127.0.0.1:${mockAddress.port}`;

  process.env.ANTHROPIC_API_KEY = 'test-mock-key';
  process.env.ANTHROPIC_BASE_URL = mockAnthropicUrl;
  process.env.AEOLUS_AI_DAILY_CAP_CENTS = '10000';

  const mail = new MemoryMailAdapter();
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'integration-test-secret-do-not-use',
    mail,
    publicBaseUrl: PUBLIC_BASE_URL,
    cookieSecure: false,
    logger: false,
    enableDevRoutes: true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    postgres,
    baseUrl,
    db,
    dbPool: pool,
    mockAnthropicUrl,
    mockServer,
    getLastUserMessage,
    async close() {
      await app.close();
      mockServer.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

async function createSessionCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) {
    throw new Error(`Failed to create dev session: ${res.status}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No set-cookie returned from /dev/sessions');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('Failed to parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

interface SseEvent {
  event: string;
  data: unknown;
}

async function collectSseEvents(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const text = await res.text();
  const lines = text.split('\n');
  let currentEvent = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      events.push({
        event: currentEvent,
        data: JSON.parse(line.slice(6)),
      });
    }
  }
  return events;
}

describe('POST /ai/assist', { timeout: 120_000 }, () => {
  let fx: Fixtures;
  let userId: string;
  let docId: string;
  let cookie: string;

  beforeAll(async () => {
    fx = await setup();
    const [user] = await fx.db
      .insert(users)
      .values({ email: 'ai-test@example.com', name: 'AI Tester', isAdmin: false })
      .returning({ id: users.id });
    userId = user.id;
    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'Test Doc', engine: 'latex', ownerId: userId })
      .returning({ id: docs.id });
    docId = doc.id;
    cookie = await createSessionCookie(fx.baseUrl, userId);
  });

  afterAll(async () => {
    await fx.close();
  });

  it('streams a response and reports cache_creation_input_tokens > 0 on first call', async () => {
    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        docId,
        selection: 'The quick brown fox jumps over the lazy dog.',
        instruction: 'Tighten this paragraph',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const events = await collectSseEvents(res);

    const chunkEvents = events.filter((e) => e.event === 'chunk');
    expect(chunkEvents.length).toBeGreaterThan(0);

    const usageEvent = events.find((e) => e.event === 'usage');
    expect(usageEvent).toBeDefined();
    const usage = (usageEvent!.data as { usage: Record<string, number> }).usage;
    expect(usage.cache_creation_input_tokens).toBeGreaterThan(0);

    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('reports cache_read_input_tokens > 0 on second call (same system prompt)', async () => {
    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        docId,
        selection: 'Another paragraph to improve.',
        instruction: 'Make it better',
      }),
    });

    expect(res.status).toBe(200);

    const events = await collectSseEvents(res);
    const usageEvent = events.find((e) => e.event === 'usage');
    expect(usageEvent).toBeDefined();
    const usage = (usageEvent!.data as { usage: Record<string, number> }).usage;
    expect(usage.cache_read_input_tokens).toBeGreaterThan(0);
  });

  it('writes an ai_requests row per call', async () => {
    const { aiRequests } = await import('@aeolus/db');
    const { eq } = await import('drizzle-orm');
    // The ledger insert is intentionally deferred until after the
    // SSE response closes (apps/api/src/routes/ai.ts:162-189) so DB
    // latency doesn't stretch the request open past the last chunk.
    // That makes the row count seen by this test race the previous
    // tests' deferred inserts (issue #49). Poll instead of asserting
    // synchronously.
    const rows = await vi.waitFor(
      async () => {
        const r = await fx.db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
        if (r.length < 2) {
          throw new Error(`expected >=2 ai_requests rows, found ${r.length}`);
        }
        return r;
      },
      { timeout: 2000, interval: 50 },
    );
    expect(rows[0].status).toBe('success');
    expect(rows[0].inputTokens).toBeGreaterThan(0);
  });

  it('returns 429 when per-hour quota is exhausted', async () => {
    const { aiQuota } = await import('@aeolus/db');
    await fx.db.insert(aiQuota).values({
      userId,
      perHour: 2,
      perDay: 200,
      tokensPerDay: 50000,
    });

    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        docId,
        selection: 'Some text',
        instruction: 'Improve it',
      }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('quota_exceeded');
  });

  it('returns 503 when global spend cap is exhausted', async () => {
    const { aiGlobalSpend, aiQuota } = await import('@aeolus/db');
    const { eq } = await import('drizzle-orm');
    await fx.db.delete(aiQuota).where(eq(aiQuota.userId, userId));

    const day = new Date().toISOString().slice(0, 10);
    await fx.db
      .insert(aiGlobalSpend)
      .values({ dayUtc: day, totalCents: 999999 })
      .onConflictDoUpdate({
        target: aiGlobalSpend.dayUtc,
        set: { totalCents: 999999 },
      });

    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        docId,
        selection: 'Some text',
        instruction: 'Improve it',
      }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('quota_exceeded');

    await fx.db.delete(aiGlobalSpend).where(eq(aiGlobalSpend.dayUtc, day));
  });

  it('returns 401 without authentication', async () => {
    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        selection: 'Some text',
        instruction: 'Improve it',
      }),
    });

    expect(res.status).toBe(401);
  });

  it('forwards errorContext into the user message when set', async () => {
    const stderr = '! Undefined control sequence.\nl.42 \\unknowncommand\n              {arg}\n';
    const source =
      '\\documentclass{article}\n\\begin{document}\n\\unknowncommand{arg}\n\\end{document}\n';
    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        docId,
        selection: source,
        instruction: 'Fix this compile error.',
        errorContext: stderr,
      }),
    });
    expect(res.status).toBe(200);
    // Drain the stream so the request settles before we read the
    // mock's captured user message.
    await collectSseEvents(res);

    const userMsg = fx.getLastUserMessage();
    expect(userMsg).not.toBeNull();
    expect(userMsg).toContain('compile error');
    expect(userMsg).toContain(stderr);
    expect(userMsg).toContain('Fix this compile error');
    expect(userMsg).toContain('\\unknowncommand');
  });

  it('rejects errorContext over the cap', async () => {
    const huge = 'x'.repeat(20_000);
    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        docId,
        selection: 'foo',
        instruction: 'fix',
        errorContext: huge,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a doc the user cannot access', async () => {
    const [otherUser] = await fx.db
      .insert(users)
      .values({ email: 'other@example.com', name: 'Other', isAdmin: false })
      .returning({ id: users.id });
    const [otherDoc] = await fx.db
      .insert(docs)
      .values({ title: 'Private', engine: 'latex', ownerId: otherUser.id })
      .returning({ id: docs.id });

    const res = await fetch(`${fx.baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        docId: otherDoc.id,
        selection: 'text',
        instruction: 'improve',
      }),
    });

    expect(res.status).toBe(404);
  });
});

describe('GET /ai/quota', { timeout: 120_000 }, () => {
  let fx: Fixtures;
  let cookie: string;

  beforeAll(async () => {
    fx = await setup();
    const [user] = await fx.db
      .insert(users)
      .values({ email: 'quota-test@example.com', name: 'Quota Tester', isAdmin: false })
      .returning({ id: users.id });
    cookie = await createSessionCookie(fx.baseUrl, user.id);
  });

  afterAll(async () => {
    await fx.close();
  });

  it('returns quota status for the authenticated user', async () => {
    const res = await fetch(`${fx.baseUrl}/api/ai/quota`, {
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hourly: { used: number; limit: number };
      daily: { used: number; limit: number };
      dailyTokens: { used: number; limit: number };
    };
    expect(body.hourly.limit).toBe(30);
    expect(body.daily.limit).toBe(200);
    expect(body.dailyTokens.limit).toBe(50000);
  });
});
