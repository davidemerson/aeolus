// Polling helpers for "has the server's asynchronous write landed yet".
//
// The ws server persists edits to `doc_updates` fire-and-forget, with no
// client-visible acknowledgement (apps/ws/src/room.ts; the `void seq` in
// apps/ws/src/server.ts), and the compile worker reports through a job
// row the API polls. From a test's point of view neither has a bound. A
// fixed sleep is therefore a guess about the CI runner's DB latency — and
// the app itself tolerates up to 1.5 s for the ws lag (EMPTY_SOURCE_RETRIES
// x EMPTY_SOURCE_RETRY_MS in apps/compile-worker/src/worker.ts). Polling
// exits as soon as the state appears, so a healthy run stays fast and a
// slow one stays green. See aeolus #77.
//
// The default budget is 10 s, not the 1.5 s the worker uses: CI runs ~45
// integration files, each with its own Postgres container, on one runner.
// A probe that passes in 40 ms locally has been seen to need over 2 s
// there (the `snapshot compaction` test, 2026-09-12). Polling means the
// budget costs nothing on a healthy run.

// Poll until `probe` returns a value that is truthy AND unchanged across
// `stableReads` consecutive reads. For "how many rows has the ws server
// persisted so far" — where the writes trickle in and a snapshot taken
// while they are still landing would under-count — this replaces "sleep
// and hope the trickle is over".
export const DEFAULT_TIMEOUT_MS = 10_000;

export async function waitForSettled<T>(
  probe: () => Promise<T> | T,
  opts: { timeoutMs?: number; intervalMs?: number; stableReads?: number; label?: string } = {},
): Promise<NonNullable<T>> {
  const stableReads = opts.stableReads ?? 3;
  const intervalMs = opts.intervalMs ?? 50;
  let prev: T | undefined;
  let streak = 0;
  return waitFor(
    async () => {
      const cur = await probe();
      if (!cur) {
        prev = cur;
        streak = 0;
        return null;
      }
      streak = JSON.stringify(cur) === JSON.stringify(prev) ? streak + 1 : 1;
      prev = cur;
      return streak >= stableReads ? cur : null;
    },
    { timeoutMs: opts.timeoutMs, intervalMs, label: opts.label },
  );
}

export async function waitFor<T>(
  probe: () => Promise<T> | T,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (last) return last as NonNullable<T>;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor${opts.label ? `(${opts.label})` : ''} timed out after ${timeoutMs}ms; last value: ${String(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
