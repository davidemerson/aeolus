import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import PgBoss from 'pg-boss';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { buildServer, MemoryMailAdapter } from '@aeolus/api';
import { createCompileWorker, type CompileWorkerHandle } from '@aeolus/compile-worker';
import { S3BlobStore } from '@aeolus/crdt';
import { db as makeDb, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

export const MINIO_IMAGE = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';

const COOKIE_SECRET = 'compile-integration-test-secret';

export interface CompileFixtures {
  postgres: StartedPostgreSqlContainer;
  minio: StartedTestContainer;
  boss: PgBoss;
  db: Database;
  dbPool: ReturnType<typeof makeDb>['pool'];
  blobs: S3BlobStore;
  s3Client: S3Client;
  bucket: string;
  app: FastifyInstance;
  apiBaseUrl: string;
  workerHandle: CompileWorkerHandle;
  tectonicBin: string;
  typstBin: string;
  close(): Promise<void>;
}

export interface CompileFixtureOptions {
  tectonicBin?: string;
  typstBin?: string;
  tectonicCacheDir?: string;
}

function whichOrNull(bin: string): string | null {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function resolveBinaries(opts: CompileFixtureOptions): {
  tectonic: string;
  typst: string;
} {
  const tectonic = opts.tectonicBin ?? process.env.AEOLUS_TECTONIC_BIN ?? whichOrNull('tectonic');
  const typst = opts.typstBin ?? process.env.AEOLUS_TYPST_BIN ?? whichOrNull('typst');
  if (!tectonic || !typst) {
    throw new Error(
      'AEOLUS_TECTONIC_BIN and AEOLUS_TYPST_BIN must be set (or passed explicitly) ' +
        'so the compile integration tests can invoke the engines.',
    );
  }
  return { tectonic, typst };
}

export async function setupCompileFixtures(
  opts: CompileFixtureOptions = {},
): Promise<CompileFixtures> {
  process.env.NODE_ENV = 'test';
  const { tectonic, typst } = resolveBinaries(opts);

  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_test')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();

  // quay.io, pinned: Docker Hub's `minio/minio` repository no longer
  // exists (pull → 404 "repository does not exist", first seen in CI
  // 2026-09-12 — it took six compile suites down on a manifest-only PR).
  // MinIO publishes to quay.io; a dated RELEASE tag keeps the fixture
  // reproducible instead of tracking a `latest` that can move or vanish.
  const minio = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({
      MINIO_ROOT_USER: 'aeolus',
      MINIO_ROOT_PASSWORD: 'aeolussecret',
    })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const connectionString = postgres.getConnectionUri();
  await runMigrations(connectionString);
  const { db, pool } = makeDb({ connectionString });

  const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  const bucket = 'aeolus-compiled';
  const s3Client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'aeolus',
      secretAccessKey: 'aeolussecret',
    },
  });
  await s3Client.send(
    new (await import('@aws-sdk/client-s3')).CreateBucketCommand({ Bucket: bucket }),
  );

  const blobs = new S3BlobStore({ bucket, client: s3Client });

  const boss = new PgBoss({ connectionString });
  await boss.start();

  const app = await buildServer({
    db,
    blobs,
    cookieSecret: COOKIE_SECRET,
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
    compileBoss: boss,
    presignCompiledPdf: async (key: string) => {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      return getSignedUrl(s3Client, cmd, { expiresIn: 300 });
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to get API listen address');
  }
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;

  const tectonicCacheDir =
    opts.tectonicCacheDir ??
    process.env.AEOLUS_TECTONIC_CACHE_DIR ??
    path.join(os.tmpdir(), 'aeolus-tectonic-cache');
  mkdirSync(tectonicCacheDir, { recursive: true });

  const workerHandle = await createCompileWorker({
    db,
    boss,
    blobs,
    tectonicBin: tectonic,
    typstBin: typst,
    tectonicCacheDir,
    concurrency: 1,
    timeoutMs: 45_000,
  });

  return {
    postgres,
    minio,
    boss,
    db,
    dbPool: pool,
    blobs,
    s3Client,
    bucket,
    app,
    apiBaseUrl,
    workerHandle,
    tectonicBin: tectonic,
    typstBin: typst,
    async close() {
      await workerHandle.close();
      await boss.stop({ graceful: true }).catch(() => undefined);
      await app.close();
      await pool.end().catch(() => undefined);
      s3Client.destroy();
      await minio.stop();
      await postgres.stop();
    },
  };
}
