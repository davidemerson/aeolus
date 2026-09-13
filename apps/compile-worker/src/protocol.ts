// Names + payload shapes shared by the api producer
// (apps/api/src/services/compile.ts) and the worker consumer
// (apps/compile-worker/src/worker.ts). The transport is pg-boss; the
// job's outcome is read back from the compile_results row, which the
// api polls. (A LISTEN/NOTIFY fan-out to ws clients existed until the
// UI moved to polling; the worker kept publishing to a channel nothing
// subscribed to until 2026-09-13.)

export const COMPILE_QUEUE_NAME = 'aeolus.compile' as const;

export interface CompileJobData {
  docId: string;
  engine: 'latex' | 'typst';
  rev: string;
  userId: string | null;
}

export interface CompileJobResult {
  status: 'success' | 'failed';
  rev: string;
  pdfKey?: string;
  error?: string;
}
