// Aeolus — a collaborative LaTeX and Typst editor you host yourself.
// Copyright (C) 2026 David Emerson
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
// for more details. You should have received a copy of it along with this
// program; if not, see <https://www.gnu.org/licenses/>.

import { blobStoreFromEnv } from '@aeolus/crdt';
import { DEV_COOKIE_SECRET, DEV_DATABASE_URL, db as createDb, requireEnv } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { createLogger } from '../log.js';
import { createWsServer } from '../server.js';

// See apps/api/src/bin/server.ts for the reasoning; ECS stopTimeout is 30 s.
const SHUTDOWN_DEADLINE_MS = 25_000;

async function main(): Promise<void> {
  const logger = createLogger();
  // Required in production (ADR 0024) — see apps/api/src/bin/server.ts.
  const connectionString = requireEnv('DATABASE_URL', DEV_DATABASE_URL);
  const cookieSecret = requireEnv('AEOLUS_COOKIE_SECRET', DEV_COOKIE_SECRET);
  // The app's origin, for the cookie-path Origin check (createWsServer).
  // Optional: unset means no Origin check, with a warning — not a boot
  // failure. It was briefly required, and the process crash-looped at start
  // in a deployment that had never carried the variable while the previous
  // version kept serving. A missing setting is a warning; the operator can
  // read a warning.
  const publicBaseUrl = process.env.AEOLUS_PUBLIC_BASE_URL;

  // Idempotent migration on boot — see comment in apps/api/src/bin/server.ts.
  await runMigrations(connectionString);

  const { db, pool } = createDb({
    connectionString,
    onPoolError: (detail, msg) => logger.error(detail, msg),
  });
  const blobs = blobStoreFromEnv();

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';

  const handle = createWsServer({
    db,
    dbPool: pool,
    blobs,
    cookieSecret,
    logger,
    allowedOrigins: publicBaseUrl ? [new URL(publicBaseUrl).origin] : undefined,
  });
  if (!publicBaseUrl) {
    logger.warn(
      'AEOLUS_PUBLIC_BASE_URL is not set: cookie-path upgrades are accepted from any Origin',
    );
  }

  await handle.listen(port, host);
  logger.info({ host, port }, 'ws listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      logger.error({ signal, deadlineMs: SHUTDOWN_DEADLINE_MS }, 'shutdown deadline hit; exiting');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    try {
      await handle.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`[ws] fatal: ${String(err)}\n`);
  process.exit(1);
});
