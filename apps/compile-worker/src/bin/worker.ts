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

import { execFileSync } from 'node:child_process';

import PgBoss from 'pg-boss';

import { blobStoreFromEnv } from '@aeolus/crdt';
import { db as makeDb, poolSslFor, requireEnv } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { createCompileWorker } from '../worker.js';

// ECS sends SIGTERM and SIGKILLs 30 s later (the manifest sets no
// stopTimeout). The worker drains in-flight compiles for up to 25 s and
// the launcher gives the whole shutdown 28 s before exiting itself.
const DRAIN_TIMEOUT_MS = 25_000;
const SHUTDOWN_DEADLINE_MS = 28_000;

async function main(): Promise<void> {
  // Both required in every environment — the worker has never had a
  // laptop default for these (ADR 0024 made api and ws match).
  const connectionString = requireEnv('DATABASE_URL');
  requireEnv('AEOLUS_S3_BUCKET');
  const tectonicBin = process.env.TECTONIC_BIN ?? '/usr/local/bin/tectonic';
  const typstBin = process.env.TYPST_BIN ?? '/usr/local/bin/typst';

  // Engine filesystem confinement (ADR 0022). Unset means no sandbox, which is
  // what a `pnpm dev` on a laptop gets; the image sets 'audit'. The boot probe
  // below says whether the running kernel would support 'enforce'.
  const sandboxMode = process.env.AEOLUS_SANDBOX_MODE;
  const sandboxBin = process.env.AEOLUS_SANDBOX_BIN ?? '/usr/local/bin/aeolus-sandbox';
  const sandbox: { bin: string; mode: 'audit' | 'enforce' } | undefined =
    sandboxMode === 'audit' || sandboxMode === 'enforce'
      ? { bin: sandboxBin, mode: sandboxMode }
      : undefined;
  if (sandbox) {
    try {
      const verdict = execFileSync(sandboxBin, ['--probe'], {
        encoding: 'utf8',
      }).trim();
      process.stdout.write(`[compile-worker] sandbox mode=${sandbox.mode}; ${verdict}\n`);
    } catch (err) {
      // A failing probe in enforce mode means every compile will fail closed;
      // surface it loudly rather than discovering it per-job.
      process.stdout.write(
        `[compile-worker] sandbox mode=${sandbox.mode}; probe FAILED: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  } else {
    process.stdout.write('[compile-worker] sandbox DISABLED (AEOLUS_SANDBOX_MODE unset)\n');
  }

  // Idempotent migration on boot — see comment in apps/api/src/bin/server.ts.
  await runMigrations(connectionString);

  const { db, pool } = makeDb({ connectionString });

  const boss = new PgBoss({ connectionString, ssl: poolSslFor(connectionString) });
  await boss.start();

  const blobs = blobStoreFromEnv();

  const handle = await createCompileWorker({
    db,
    boss,
    blobs,
    tectonicBin,
    typstBin,
    tectonicCacheDir: process.env.TECTONIC_CACHE_DIR,
    sandbox,
    // Optional bundle override (issue #11). Operators populate
    // AEOLUS_TECTONIC_BUNDLE with an S3 HTTPS URL pointing at a
    // pinned Tectonic bundle when they want the worker independent
    // of the public relay. See docs/RUNBOOKS/tectonic-bundle.md.
    tectonicBundle: process.env.AEOLUS_TECTONIC_BUNDLE,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
  });

  if (process.env.AEOLUS_TECTONIC_BUNDLE) {
    process.stdout.write(
      `[compile-worker] using pinned Tectonic bundle: ${process.env.AEOLUS_TECTONIC_BUNDLE}\n`,
    );
  }

  process.stdout.write('[compile-worker] ready\n');

  // The worker has no listener and no health probe: it is healthy as long as
  // the process is up. The pg-boss consumer is event-driven and only exits on
  // an unrecoverable error.
  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(
      `[compile-worker] received ${signal}, draining ${handle.inFlight()} compile(s)\n`,
    );
    const deadline = setTimeout(() => {
      process.stderr.write(
        `[compile-worker] shutdown deadline (${SHUTDOWN_DEADLINE_MS} ms) hit; exiting\n`,
      );
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    try {
      await handle.close();
      await boss.stop({ graceful: true, wait: true });
      await pool.end();
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[compile-worker] shutdown failed: ${String(err)}\n`);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[compile-worker] fatal: ${String(err)}\n`);
  process.exit(1);
});
