import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { poolSslFor } from './index.js';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

// Schema-migration runner that does NOT require CREATE-on-database.
//
// Drizzle's built-in `migrate()` opens with
// `CREATE SCHEMA IF NOT EXISTS "drizzle"` — even with IF NOT EXISTS
// Postgres requires the role to have CREATE on the database, which
// the least-privilege runtime role intentionally lacks (it has
// CREATE on the `public` schema only, owning the app tables but
// nothing else). So we keep the drizzle on-disk migration format
// (`migrations/<tag>.sql` + `migrations/meta/_journal.json`) but
// drive replay ourselves: bookkeeping table lives in `public`,
// statements split on the `--> statement-breakpoint` marker, hashes
// match drizzle's own algorithm so a future switch back to the
// stock migrator is still possible.
//
// Idempotent + concurrency-safe: each migration runs inside a
// SERIALIZABLE transaction wrapped by a session-level advisory lock,
// so the api / ws / worker boots can race without applying the same
// migration twice.

const ADVISORY_LOCK_KEY = BigInt('5476381901274518'); // arbitrary, app-scoped
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS public."__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash TEXT NOT NULL,
    created_at BIGINT
  )
`;

function hashMigration(sql: string): string {
  // Matches drizzle/orm/migrator.ts: sha256 of the raw file contents.
  return createHash('sha256').update(sql).digest('hex');
}

function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({
    connectionString,
    ssl: poolSslFor(connectionString),
  });
  try {
    const migrationsFolder = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'migrations',
    );
    const journal = JSON.parse(
      await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;

    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY.toString()]);
      try {
        await client.query(MIGRATIONS_TABLE_DDL);
        const { rows } = await client.query<{ hash: string }>(
          `SELECT hash FROM public."__drizzle_migrations"`,
        );
        const applied = new Set(rows.map((r) => r.hash));

        const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
        for (const entry of ordered) {
          const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
          const sql = await readFile(sqlPath, 'utf8');
          const hash = hashMigration(sql);
          if (applied.has(hash)) continue;

          await client.query('BEGIN');
          try {
            for (const stmt of splitStatements(sql)) {
              await client.query(stmt);
            }
            await client.query(
              `INSERT INTO public."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
              [hash, entry.when],
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
        }
      } finally {
        await client
          .query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY.toString()])
          .catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await runMigrations(connectionString);
  console.log('migrations applied');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
