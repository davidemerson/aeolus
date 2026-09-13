import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { auditEvents, db as makeDb, users, type Database } from '@aeolus/db';
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
    cookieSecret: 'audit-test-secret',
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

async function devCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const sc = res.headers.get('set-cookie');
  const p = parseSetCookie(sc!);
  return `${p!.name}=${p!.value}`;
}

describe('audit log + admin endpoint', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('emits an event for doc.create and surfaces it via /admin/audit-events', async () => {
    const [admin] = await fx.db
      .insert(users)
      .values({
        email: `audit-admin-${Date.now()}@example.com`,
        isAdmin: true,
      })
      .returning({ id: users.id });
    const cookie = await devCookie(fx.baseUrl, admin.id);

    const create = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Audited Doc', engine: 'latex' }),
    });
    expect(create.status).toBe(201);
    const { id: docId } = (await create.json()) as { id: string };

    const list = await fetch(`${fx.baseUrl}/api/admin/audit-events`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      events: Array<{
        action: string;
        actor_id: string | null;
        resource_id: string | null;
        metadata: Record<string, unknown>;
      }>;
      retention_days: number;
    };
    expect(body.retention_days).toBe(30);
    const docCreate = body.events.find((e) => e.action === 'doc.create' && e.resource_id === docId);
    expect(docCreate).toBeDefined();
    expect(docCreate!.actor_id).toBe(admin.id);
    expect(docCreate!.metadata.title).toBe('Audited Doc');
    expect(docCreate!.metadata.engine).toBe('latex');
  });

  it('captures actor_email at event time so the row survives later user deletion', async () => {
    const [u] = await fx.db
      .insert(users)
      .values({ email: `audit-survive-${Date.now()}@example.com`, isAdmin: true })
      .returning({ id: users.id, email: users.email });
    const cookie = await devCookie(fx.baseUrl, u.id);
    await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Survivor', engine: 'latex' }),
    });

    // Direct row inspection — we want to confirm the email column,
    // which the list endpoint also surfaces but is easier to assert
    // here without filtering.
    const rows = await fx.db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.actorId} = ${u.id}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].actorEmail).toBe(u.email);
  });

  it('filters by action prefix', async () => {
    const [admin] = await fx.db
      .insert(users)
      .values({
        email: `audit-filter-${Date.now()}@example.com`,
        isAdmin: true,
      })
      .returning({ id: users.id });
    const cookie = await devCookie(fx.baseUrl, admin.id);

    // Create a doc, then PATCH it — two distinct actions.
    const create = await fetch(`${fx.baseUrl}/api/docs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'F1', engine: 'latex' }),
    });
    const { id } = (await create.json()) as { id: string };
    await fetch(`${fx.baseUrl}/api/docs/${id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'F2' }),
    });

    const docOnly = await fetch(`${fx.baseUrl}/api/admin/audit-events?action=doc.`, {
      headers: { cookie },
    });
    expect(docOnly.status).toBe(200);
    const body = (await docOnly.json()) as {
      events: Array<{ action: string }>;
    };
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.events.every((e) => e.action.startsWith('doc.'))).toBe(true);

    const exact = await fetch(`${fx.baseUrl}/api/admin/audit-events?action=doc.update`, {
      headers: { cookie },
    });
    const exactBody = (await exact.json()) as {
      events: Array<{ action: string }>;
    };
    expect(exactBody.events.every((e) => e.action === 'doc.update')).toBe(true);
  });

  it('rejects non-admins with 403 and unauth callers with 401', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({
        email: `audit-non-admin-${Date.now()}@example.com`,
        isAdmin: false,
      })
      .returning({ id: users.id });
    const cookie = await devCookie(fx.baseUrl, user.id);
    const forbidden = await fetch(`${fx.baseUrl}/api/admin/audit-events`, {
      headers: { cookie },
    });
    expect(forbidden.status).toBe(403);
    const anon = await fetch(`${fx.baseUrl}/api/admin/audit-events`);
    expect(anon.status).toBe(401);
  });

  it('prunes rows older than 30 days as a side effect of the list call', async () => {
    const [admin] = await fx.db
      .insert(users)
      .values({
        email: `audit-prune-${Date.now()}@example.com`,
        isAdmin: true,
      })
      .returning({ id: users.id });
    const cookie = await devCookie(fx.baseUrl, admin.id);

    // Insert a stale row ~60 days old. It should be wiped by the
    // list endpoint's retention sweep and never surfaced.
    await fx.db.insert(auditEvents).values({
      action: 'doc.create',
      actorId: admin.id,
      actorEmail: 'stale@example.com',
      resourceType: 'doc',
      resourceId: '00000000-0000-0000-0000-000000000000',
      metadata: { stale: true },
      occurredAt: sql`now() - interval '60 days'` as unknown as Date,
    });

    const list = await fetch(`${fx.baseUrl}/api/admin/audit-events`, {
      headers: { cookie },
    });
    const body = (await list.json()) as {
      events: Array<{ metadata: Record<string, unknown> }>;
    };
    expect(body.events.find((e) => e.metadata.stale)).toBeUndefined();

    // And it's actually gone from the table, not just filtered out.
    const remaining = await fx.db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.metadata}->>'stale' = 'true'`);
    expect(remaining).toHaveLength(0);
  });
});
