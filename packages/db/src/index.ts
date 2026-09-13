import { existsSync, readFileSync } from 'node:fs';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { DEV_DATABASE_URL, isProduction } from './env.js';
import * as schema from './schema.js';

export * from './env.js';
export * from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbOptions {
  connectionString?: string;
  pool?: pg.Pool;
  // Where idle-client errors go (see onPoolError). Default: a JSON line
  // on stderr.
  onPoolError?: PoolErrorLogger;
}

// A PEM bundle to verify the database server's certificate chain against.
// Point AEOLUS_DB_CA_FILE at your provider's root bundle when the database is
// somewhere TLS matters; the stock compose stack keeps Postgres on a private
// network and needs none.
const DEFAULT_CA_PATH = '/etc/ssl/certs/aeolus-db-ca.pem';
function readCaFile(): string | null {
  const path = process.env.AEOLUS_DB_CA_FILE?.trim() || DEFAULT_CA_PATH;
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
const configuredCa: string | null = readCaFile();

export type PgSslConfig = false | { rejectUnauthorized: boolean; ca?: string };

export interface PoolSslOptions {
  // Injection points for tests; production callers pass nothing.
  ca?: string | null;
  production?: boolean;
  // Where the "unverified TLS" warning goes when it applies.
  warn?: (line: string) => void;
  // AEOLUS_DB_SSL, when the caller wants to pass it explicitly.
  mode?: string;
}

/**
 * AEOLUS_DB_SSL decides TLS outright:
 *
 *   disable  no TLS. What the bundled compose stack uses — Postgres is on a
 *            private Docker network with no published port.
 *   require  TLS, certificate not verified. Encrypted against a passive
 *            listener; useless against an active one.
 *   verify   TLS, chain verified against AEOLUS_DB_CA_FILE. The right answer
 *            for a managed database reached across a network.
 *
 * Unset falls back to the hostname heuristic below, which is what an install
 * that never thinks about this gets.
 */
export type DbSslMode = 'disable' | 'require' | 'verify';

function parseSslMode(raw: string | undefined): DbSslMode | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === 'disable' || value === 'off' || value === 'false' || value === '0')
    return 'disable';
  if (value === 'require' || value === 'on' || value === 'true' || value === '1') return 'require';
  if (value === 'verify' || value === 'verify-full') return 'verify';
  throw new Error(`AEOLUS_DB_SSL must be disable, require or verify (got ${raw})`);
}

/**
 * How to talk TLS to the database.
 *
 * AEOLUS_DB_SSL, if set, is the answer and nothing else is consulted. Set it:
 * the fallback below is a guess from the hostname, and a guess is exactly the
 * wrong thing when a wrong answer is a process that will not boot.
 *
 * The fallback exists because a managed Postgres usually refuses an
 * unencrypted connection (RDS ships `rds.force_ssl=1`) while pg's default is
 * no TLS at all, so an unconfigured install pointed at one would crash with
 * `no pg_hba.conf entry ... no encryption` and no hint as to why. So: no TLS
 * for a host that is plainly local, TLS for anything else, verified when a CA
 * bundle is present.
 */
export function poolSslFor(connectionString: string, opts: PoolSslOptions = {}): PgSslConfig {
  const ca = opts.ca === undefined ? configuredCa : opts.ca;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(line + '\n'));
  const redacted = connectionString.replace(/\/\/.*@/, '//<redacted>@');

  const mode = parseSslMode(opts.mode ?? process.env.AEOLUS_DB_SSL);
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify') {
    if (!ca) {
      throw new Error(
        'AEOLUS_DB_SSL=verify but no CA bundle was found. Set AEOLUS_DB_CA_FILE to your ' +
          `database provider's root certificate bundle (looked at ${
            process.env.AEOLUS_DB_CA_FILE?.trim() || DEFAULT_CA_PATH
          }).`,
      );
    }
    return { rejectUnauthorized: true, ca };
  }

  const lower = connectionString.toLowerCase();
  const looksLocal =
    lower.includes('@localhost') ||
    lower.includes('@127.0.0.1') ||
    lower.includes('@::1') ||
    lower.includes('@postgres:') || // the compose service hostname
    lower.includes('@db:');
  if (looksLocal) return false;

  if (ca) return { rejectUnauthorized: true, ca };

  if (opts.production ?? isProduction()) {
    throw new Error(
      `Refusing to guess: ${redacted} is not a local address, no CA bundle was found, and ` +
        'AEOLUS_DB_SSL is unset. Set AEOLUS_DB_SSL to disable, require or verify.',
    );
  }
  warn(
    `[db] no CA bundle found; connecting to ${redacted} with TLS but WITHOUT certificate ` +
      'verification. Set AEOLUS_DB_SSL to say what you meant.',
  );
  return { rejectUnauthorized: false };
}

// Per-session bounds applied at connection startup via libpq
// `options=-c …` parameters. Without these, a stuck client (or a
// forgotten BEGIN) holds a connection and a transaction
// indefinitely; the only previous bound was the network-level pg
// keepalive.
//
// Picked values:
//   - statement_timeout 30s exceeds the slowest expected app query
//     (snapshot replay is bounded by SNAPSHOT_UPDATE_THRESHOLD) by
//     a wide margin while still catching pathological scans.
//   - idle_in_transaction_session_timeout 60s catches a forgotten
//     BEGIN before it blocks DDL / autovacuum.
//
// Setting these via libpq options (rather than a SET in a
// `pool.on('connect', …)` handler) means the limits apply to the
// very first query on a fresh connection — there's no race between
// the handler's async SET and the user's first query (which would
// have triggered a pg deprecation warning about overlapping
// queries on the same client).
const STARTUP_OPTIONS = '-c statement_timeout=30s -c idle_in_transaction_session_timeout=60s';

// pg-pool re-emits an idle client's socket error as `'error'` on the
// pool itself. Node treats an `'error'` event with no listener as an
// uncaught exception, so a pool without one turns *any* server-side
// disconnect of an idle connection — an RDS Multi-AZ failover, a
// `pg_terminate_backend`, a Postgres restart (`57P01 terminating
// connection due to administrator command`) — into a process crash,
// even though the pool has already discarded that client and the next
// checkout would simply open a fresh one. Every process here (api, ws,
// worker) builds its pool through `db()`, so attaching the listener
// once, here, covers all of them. The handler logs and returns; it
// never rethrows. Surfaced by the E2E teardown (the testcontainer
// stopped while the pool still held an idle client), not by an
// incident — see docs/ARCHITECTURE.md § Database access.
export function onPoolError(
  err: Error & { code?: string },
  log: PoolErrorLogger = defaultPoolErrorLogger,
): void {
  log({ code: err.code ?? null, message: err.message }, 'idle pool client error');
}

// (detail, message) — the shape of pino's `logger.error(obj, msg)`, so a
// process with a real logger passes `app.log.error.bind(app.log)` and one
// without gets a JSON line on stderr that a log group can still index.
export type PoolErrorLogger = (
  detail: { code: string | null; message: string },
  msg: string,
) => void;

const defaultPoolErrorLogger: PoolErrorLogger = (detail, msg) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', source: 'db', msg, ...detail })}\n`);
};

export function db(options: DbOptions = {}): { db: Database; pool: pg.Pool } {
  // DEV_DATABASE_URL is the laptop default. The launchers resolve the
  // production value through requireEnv() before calling this, so the
  // fallback here is only reached by tests and local tooling.
  const connectionString = options.connectionString ?? process.env.DATABASE_URL ?? DEV_DATABASE_URL;
  let pool = options.pool;
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      ssl: poolSslFor(connectionString),
      options: STARTUP_OPTIONS,
    });
    const onError = options.onPoolError;
    pool.on('error', (err) => onPoolError(err, onError));
  }
  return { db: drizzle(pool, { schema }), pool };
}
