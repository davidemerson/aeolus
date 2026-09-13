import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import PgBoss from 'pg-boss';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { createCompileWorker } from '@aeolus/compile-worker';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { createWsServer } from '@aeolus/ws';

import { COOKIE_SECRET, STATE_FILE } from './stack-state.js';

const API_PORT = 4000;
const WS_PORT = 4001;
const WEB_PORT = 5173;

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

export default async function globalSetup(): Promise<void> {
  process.stdout.write('[e2e] starting postgres...\n');
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_e2e')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();
  const databaseUrl = postgres.getConnectionUri();

  process.stdout.write('[e2e] applying migrations...\n');
  await runMigrations(databaseUrl);

  process.stdout.write('[e2e] booting api...\n');
  const { db, pool: pgPool } = makeDb({ connectionString: databaseUrl });
  const mail = new MemoryMailAdapter();
  const blobs = new MemoryBlobStore();

  const boss = new PgBoss({ connectionString: databaseUrl });
  await boss.start();

  const apiApp = await buildServer({
    db,
    blobs,
    cookieSecret: COOKIE_SECRET,
    cookieSecure: false,
    mail,
    publicBaseUrl: `http://localhost:${WEB_PORT}`,
    enableDevRoutes: true,
    logger: false,
    compileBoss: boss,
  });
  await apiApp.listen({ host: 'localhost', port: API_PORT });

  process.stdout.write('[e2e] booting ws...\n');
  const wsHandle = createWsServer({
    db,
    dbPool: pgPool,
    blobs,
    cookieSecret: COOKIE_SECRET,
  });
  await wsHandle.listen(WS_PORT, 'localhost');

  process.stdout.write('[e2e] booting compile worker...\n');
  const tectonicBin = process.env.AEOLUS_TECTONIC_BIN ?? 'tectonic';
  const typstBin = process.env.AEOLUS_TYPST_BIN ?? 'typst';
  const tectonicCacheDir =
    process.env.AEOLUS_TECTONIC_CACHE_DIR ?? path.join(os.tmpdir(), 'aeolus-tectonic-cache');
  mkdirSync(tectonicCacheDir, { recursive: true });

  const workerHandle = await createCompileWorker({
    db,
    boss,
    blobs,
    tectonicBin,
    typstBin,
    tectonicCacheDir,
    concurrency: 1,
    timeoutMs: 45_000,
  });

  process.stdout.write('[e2e] booting vite...\n');
  const webDir = path.join(REPO_ROOT, 'apps', 'web');
  const webProc = spawn(
    'pnpm',
    ['exec', 'vite', '--host', 'localhost', '--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: webDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(WEB_PORT),
        HOST: 'localhost',
        AEOLUS_API_URL: `http://localhost:${API_PORT}`,
        AEOLUS_WS_URL: `ws://localhost:${WS_PORT}`,
      },
    },
  );
  webProc.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[vite] ${chunk.toString()}`);
  });
  webProc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[vite:err] ${chunk.toString()}`);
  });

  await waitForHttp(`http://localhost:${WEB_PORT}/`);
  // /healthz, not /me: every api route lives under /api, so
  // `/me` is a permanent 404 — and waitForHttp treats anything
  // under 500 as ready, so that probe returned the instant the
  // socket accepted and proved nothing about the routes being
  // registered. /healthz is the real liveness contract (and the
  // one a load balancer would probe).
  await waitForHttp(`http://localhost:${API_PORT}/healthz`);
  process.stdout.write('[e2e] stack ready\n');

  const state = {
    databaseUrl,
    apiPort: API_PORT,
    wsPort: WS_PORT,
    webPort: WEB_PORT,
    webPid: webProc.pid ?? null,
    postgresId: postgres.getId(),
  };

  const stateDir = path.dirname(STATE_FILE);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const stash = globalThis as unknown as {
    __e2eStack?: {
      apiApp: typeof apiApp;
      wsHandle: typeof wsHandle;
      workerHandle: typeof workerHandle;
      boss: typeof boss;
      pgPool: typeof pgPool;
      postgres: typeof postgres;
      webProc: typeof webProc;
    };
  };
  stash.__e2eStack = {
    apiApp,
    wsHandle,
    workerHandle,
    boss,
    pgPool,
    postgres,
    webProc,
  };
}
