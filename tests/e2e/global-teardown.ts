import type { FastifyInstance } from 'fastify';

export default async function globalTeardown(): Promise<void> {
  const stash = globalThis as unknown as {
    __e2eStack?: {
      apiApp: FastifyInstance;
      wsHandle: { close: () => Promise<void> };
      workerHandle: { close: () => Promise<void> };
      boss: { stop: (opts?: { graceful?: boolean }) => Promise<void> };
      pgPool: { end: () => Promise<void> };
      postgres: { stop: () => Promise<unknown> };
      webProc: { kill: (signal?: NodeJS.Signals) => boolean };
    };
  };
  const stack = stash.__e2eStack;
  if (!stack) return;

  try {
    stack.webProc.kill('SIGTERM');
  } catch {
    /* ignore */
  }

  try {
    await stack.workerHandle.close();
  } catch {
    /* ignore */
  }
  try {
    await stack.apiApp.close();
  } catch {
    /* ignore */
  }
  try {
    await stack.wsHandle.close();
  } catch {
    /* ignore */
  }
  try {
    await stack.boss.stop({ graceful: true });
  } catch {
    /* ignore */
  }

  try {
    await stack.pgPool.end();
  } catch {
    /* ignore */
  }
  try {
    await stack.postgres.stop();
  } catch {
    /* ignore */
  }
  stash.__e2eStack = undefined;
}
