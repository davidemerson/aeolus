import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
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
  const app = await buildServer({
    db,
    blobs: new MemoryBlobStore(),
    cookieSecret: 'v1-openapi-test-secret',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    postgres,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

let fx: Fixtures;
beforeAll(async () => {
  fx = await setup();
}, 180_000);
afterAll(async () => {
  await fx?.close();
});

interface Spec {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, { summary?: string; tags?: string[]; responses?: unknown }>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
}

async function spec(): Promise<Spec> {
  const res = await fetch(`${fx.baseUrl}/api/v1/openapi.json`);
  expect(res.status).toBe(200);
  return (await res.json()) as Spec;
}

describe('the generated OpenAPI description', () => {
  it('is OpenAPI 3.1 and declares the bearer scheme', async () => {
    const s = await spec();
    expect(s.openapi).toBe('3.1.0');
    expect(s.info.title).toContain('Aeolus');
    expect(s.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('describes every v1 route, and each carries a summary and tags', async () => {
    const s = await spec();
    expect(Object.keys(s.paths)).toContain('/me');
    for (const [path, methods] of Object.entries(s.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(op.summary, `${method.toUpperCase()} ${path} has no summary`).toBeTruthy();
        expect(op.tags?.length, `${method.toUpperCase()} ${path} has no tags`).toBeTruthy();
        expect(op.responses, `${method.toUpperCase()} ${path} has no responses`).toBeTruthy();
      }
    }
  });

  // The plane is a contract; the browser plane is not. @fastify/swagger is
  // fastify-plugin-wrapped and sees every route in the app, so without the
  // transform this would publish ~60 schemaless UI routes as if they were API.
  it('does NOT leak the browser plane into the description', async () => {
    const s = await spec();
    const leaked = Object.keys(s.paths).filter(
      (p) => p.startsWith('/api/') || p.includes('/auth/') || p === '/healthz',
    );
    expect(leaked).toEqual([]);
  });

  // `produces` is route-wide in Fastify, so declaring the assist stream's
  // content type also relabelled that operation's JSON error bodies as event
  // streams — a generated client would have tried to parse a 404 as a stream.
  // Nothing failed at boot or at request time; only reading the document found
  // it, which is the argument for committing and diffing it.
  it('describes the streaming operation as a stream, and its errors as JSON', async () => {
    const s = await spec();
    const responses = s.paths['/ai/assist'].post.responses as Record<
      string,
      { content?: Record<string, unknown> }
    >;
    expect(Object.keys(responses['200'].content ?? {})).toEqual(['text/event-stream']);
    for (const status of ['403', '404', '429', '503']) {
      expect(Object.keys(responses[status].content ?? {}), `${status} content type`).toEqual([
        'application/json',
      ]);
    }
  });

  it('emits shared schemas once, under components', async () => {
    const s = await spec();
    expect(Object.keys(s.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(['ErrorResponse', 'UserSummary', 'TokenSummary']),
    );
  });

  // fastify-type-provider-zod registers an `Input` twin of every schema,
  // because a zod schema can transform on parse. Only one of each pair is ever
  // used — a request body refs the Input, a response refs the base — so the
  // other half was dead weight, and it was HALF the document: 61 of 122
  // components, each of which a client generator would have emitted as a type
  // nobody can reach.
  it('carries no component nothing references', async () => {
    const s = await spec();
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const ref = (node as { $ref?: unknown }).$ref;
      if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
        refs.add(ref.slice('#/components/schemas/'.length));
      }
      Object.values(node as Record<string, unknown>).forEach(walk);
    };
    walk(s.paths);
    // One pass over the kept components picks up nested refs; the prune itself
    // runs to a fixpoint, so a single expansion here is enough to check it.
    for (const name of [...refs]) walk(s.components?.schemas?.[name]);

    const dead = Object.keys(s.components?.schemas ?? {}).filter((n) => !refs.has(n));
    expect(dead, 'components no operation can reach').toEqual([]);
  });

  it('serves YAML too', async () => {
    const res = await fetch(`${fx.baseUrl}/api/v1/openapi.yaml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('yaml');
    expect(await res.text()).toContain('openapi: 3.1.0');
  });
});

/**
 * The third drift layer from ADR 0019, and the weakest of the three — say so
 * rather than imply the hand-written half is verified.
 *
 * It catches the failure that actually happens: a route ships and nobody writes
 * the prose. It CANNOT catch prose about an existing route going stale, and it
 * checks paths rather than operations, so adding a method to a path already
 * documented slips through. Both are why `docs/API.md` is reviewed, not just
 * linted.
 */
describe('the hand-written reference keeps up', () => {
  let apiMd: string;

  beforeAll(async () => {
    apiMd = await readFile(new URL('../../docs/API.md', import.meta.url), 'utf8');
  });

  it('mentions every path the description declares', async () => {
    const s = await spec();
    const undocumented = Object.keys(s.paths).filter((p) => !apiMd.includes(`/api/v1${p}`));
    expect(undocumented, 'these routes exist but docs/API.md does not name them').toEqual([]);
  });
});

describe('the reference UI', () => {
  it('is served, and is HTML', async () => {
    const res = await fetch(`${fx.baseUrl}/api/v1/reference`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  // The estate's CSP/CDN posture is that pages serve their own assets. Scalar
  // bundles its own JS by design; this pins that it stays that way, because a
  // future version quietly switching to a CDN would break on a ZT-only host
  // with no egress guarantee — and would do it silently, as a blank page.
  it('serves its own bundle rather than reaching for a CDN', async () => {
    const html = await (await fetch(`${fx.baseUrl}/api/v1/reference`)).text();
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('unpkg.com');

    const js = await fetch(`${fx.baseUrl}/api/v1/reference/js/scalar.js`);
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(1000);
  });
});

describe('reachability of the description', () => {
  // Requiring a token to read the document that explains how to get a token is
  // a bootstrap loop. An API description is not a secret: it says what the
  // routes are, and every one of them still refuses an unauthenticated
  // caller.
  it.each(['/api/v1/openapi.json', '/api/v1/openapi.yaml', '/api/v1/reference'])(
    '%s needs no credential',
    async (path) => {
      expect((await fetch(`${fx.baseUrl}${path}`)).status).toBe(200);
    },
  );

  it('still gates everything else', async () => {
    expect((await fetch(`${fx.baseUrl}/api/v1/me`)).status).toBe(401);
    expect((await fetch(`${fx.baseUrl}/api/v1/anything-else`)).status).toBe(401);
  });
});
