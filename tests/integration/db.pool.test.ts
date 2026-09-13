import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

// Per-session settings applied by the pool's 'connect' handler in
// packages/db/src/index.ts. A runaway query held a connection
// indefinitely before this; an idle transaction blocked DDL and
// autovacuum. The handler runs on every new connection (including
// new pool clients), so checking out a fresh client and reading
// SHOW <param> verifies the wiring end-to-end.
describe('db pool per-connection settings', () => {
  let container: StartedPostgreSqlContainer;
  let pool: ReturnType<typeof db>['pool'];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('aeolus_test')
      .withUsername('aeolus')
      .withPassword('aeolus')
      .start();
    const connectionString = container.getConnectionUri();
    await runMigrations(connectionString);
    pool = db({ connectionString }).pool;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('sets statement_timeout to 30s', async () => {
    const client = await pool.connect();
    try {
      // The 'connect' handler runs asynchronously after the client
      // emits 'connect'; pg's pool.connect() awaits the connect
      // event but not subsequent queries. Issue a no-op first to
      // ensure the SET has had a chance to flush.
      await client.query('select 1');
      const { rows } = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(rows[0]?.statement_timeout).toBe('30s');
    } finally {
      client.release();
    }
  });

  // pg-pool re-emits an idle client's socket error as 'error' on the pool.
  // With no listener that is an uncaught exception, so a server-side
  // disconnect of an idle connection — an RDS Multi-AZ failover, a
  // Postgres restart, pg_terminate_backend — would crash api/ws/worker.
  // This drives the real path, no mocks: check a client out, learn its
  // backend pid, release it (idle in the pool), terminate that backend
  // from another connection, and prove the process is still here and the
  // pool still serves queries. Surfaced by the E2E teardown (57P01 from
  // the stopping testcontainer), fixed in packages/db/src/index.ts.
  it('survives an idle client being terminated server-side (57P01)', async () => {
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);

    const victim = await pool.connect();
    const { rows } = await victim.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]!.pid;
    // Acquire the killer while the victim is still checked out, so the
    // pool has to open a second connection — releasing first would hand
    // the victim straight back as the "killer" and it would terminate
    // itself (which is exactly what the first CI run of this test did).
    const killer = await pool.connect();
    victim.release(); // now idle in the pool, wearing pg-pool's idleListener

    const poolError = new Promise<Error & { code?: string }>((resolve) => {
      pool.once('error', (err) => resolve(err as Error & { code?: string }));
    });
    try {
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      killer.release();
    }

    const err = await poolError;
    expect(err.code).toBe('57P01');
    // The pool discarded the dead client and opens a fresh one.
    const { rows: after } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(after[0]?.ok).toBe(1);
  });

  it('sets idle_in_transaction_session_timeout to 60s', async () => {
    const client = await pool.connect();
    try {
      await client.query('select 1');
      const { rows } = await client.query<{
        idle_in_transaction_session_timeout: string;
      }>('SHOW idle_in_transaction_session_timeout');
      expect(rows[0]?.idle_in_transaction_session_timeout).toBe('1min');
    } finally {
      client.release();
    }
  });
});
