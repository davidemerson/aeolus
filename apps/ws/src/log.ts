import pino, { type Logger } from 'pino';

// One JSON line per event, the same shape apps/api gets from Fastify's
// built-in pino. Before 2026-09-13 the ws process wrote free-text lines
// with process.stdout.write / process.stderr.write and no level, so the
// log group could not be filtered by severity and `persistUpdateBatch`
// failures were indistinguishable from the startup banner.
export type WsLogger = Logger;

export function createLogger(): WsLogger {
  return pino({
    name: 'ws',
    // AEOLUS_LOG_LEVEL is read by ws only; api takes Fastify's default.
    level: process.env.AEOLUS_LOG_LEVEL ?? 'info',
  });
}
