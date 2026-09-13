import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  COMPILE_QUEUE_NAME,
  createCompileWorker,
  type CompileWorkerHandle,
} from '@aeolus/compile-worker';
import { MemoryBlobStore, persistUpdate } from '@aeolus/crdt';
import { compileResults, db as makeDb, docFiles, docs, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { waitFor } from './helpers/poll.js';

// SIGTERM used to kill compiles mid-flight: CompileWorkerHandle.close()
// returned as soon as the pg-boss subscription was off, and the launcher's
// process.exit() took the running engines with it, leaving their
// compile_results rows `running` forever (ADR 0024). close() now waits for
// in-flight jobs, bounded by drainTimeoutMs.
//
// No real engine here: a shell script that sleeps and exits 1 stands in
// for tectonic, so the test runs without the tectonic binary or MinIO.

const ENGINE_RUNTIME_MS = 2_000;

describe('compile worker drain on close', () => {
  let postgres: StartedPostgreSqlContainer;
  let db: Database;
  let pool: ReturnType<typeof makeDb>['pool'];
  let boss: PgBoss;
  let handle: CompileWorkerHandle;
  let fakeEngine: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('aeolus_test')
      .withUsername('aeolus')
      .withPassword('aeolus')
      .start();
    const connectionString = postgres.getConnectionUri();
    await runMigrations(connectionString);
    ({ db, pool } = makeDb({ connectionString }));
    boss = new PgBoss({ connectionString });
    await boss.start();

    const dir = await mkdtemp(path.join(tmpdir(), 'aeolus-fake-engine-'));
    fakeEngine = path.join(dir, 'tectonic');
    await writeFile(
      fakeEngine,
      `#!/bin/sh\nsleep ${ENGINE_RUNTIME_MS / 1000}\necho 'fake engine: no output' >&2\nexit 1\n`,
    );
    await chmod(fakeEngine, 0o755);

    handle = await createCompileWorker({
      db,
      boss,
      blobs: new MemoryBlobStore(),
      tectonicBin: fakeEngine,
      typstBin: fakeEngine,
      drainTimeoutMs: 15_000,
      workdirBase: dir,
    });
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false }).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await postgres?.stop();
  });

  it('close() waits for the running compile, which reaches a terminal row', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [owner] = await db
      .insert(users)
      .values({ email: `owner-${suffix}@example.com`, name: 'Owner', isAdmin: false })
      .returning({ id: users.id });
    const [doc] = await db
      .insert(docs)
      .values({ title: `Drain ${suffix}`, engine: 'latex', ownerId: owner.id })
      .returning({ id: docs.id });
    await db
      .insert(docFiles)
      .values({ docId: doc.id, path: 'main.tex', kind: 'text', yjsDocId: doc.id });
    // Non-empty source, or processJob fails before it ever spawns the engine.
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, '\\documentclass{article}\\begin{document}x\\end{document}');
    await persistUpdate(
      { db, blobs: new MemoryBlobStore() },
      doc.id,
      1n,
      Y.encodeStateAsUpdate(ydoc),
      owner.id,
    );

    const jobId = await boss.send(COMPILE_QUEUE_NAME, {
      docId: doc.id,
      engine: 'latex',
      rev: '1',
      userId: owner.id,
    });
    expect(jobId).toBeTruthy();
    await db.insert(compileResults).values({
      docId: doc.id,
      jobId: jobId as string,
      engine: 'latex',
      rev: 1n,
      status: 'queued',
    });

    const status = async (): Promise<string | undefined> =>
      (
        await db
          .select({ status: compileResults.status })
          .from(compileResults)
          .where(eq(compileResults.jobId, jobId as string))
      )[0]?.status;

    await waitFor(async () => ((await status()) === 'running' ? true : null), {
      label: 'compile picked up',
    });
    expect(handle.inFlight()).toBe(1);

    const started = Date.now();
    await handle.close();
    const waited = Date.now() - started;

    // close() came back only after the engine finished (it sleeps
    // ENGINE_RUNTIME_MS), and the row is terminal, not stuck at `running`.
    expect(handle.inFlight()).toBe(0);
    expect(waited).toBeGreaterThanOrEqual(ENGINE_RUNTIME_MS * 0.5);
    expect(await status()).toBe('failed');
  });
});
