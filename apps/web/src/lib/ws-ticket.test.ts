import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ApiRequestError } from './api.js';
import {
  attachTicketRefresh,
  type MintResult,
  type TicketRefreshHandle,
  type TerminalInfo,
} from './ws-ticket.js';

const TTL_MS = 5 * 60 * 1000;

type CloseHandler = (event: CloseEvent | null) => void;
type SyncHandler = (isSynced: boolean) => void;

function makeProvider() {
  const closeHandlers = new Set<CloseHandler>();
  const syncHandlers = new Set<SyncHandler>();
  return {
    params: { docId: 'doc-1', ticket: 't0' } as { [key: string]: string },
    shouldConnect: true,
    disconnectCalls: 0,
    disconnect() {
      this.disconnectCalls += 1;
    },
    on(name: string, handler: CloseHandler | SyncHandler) {
      if (name === 'connection-close') closeHandlers.add(handler as CloseHandler);
      if (name === 'sync') syncHandlers.add(handler as SyncHandler);
    },
    off(name: string, handler: CloseHandler | SyncHandler) {
      if (name === 'connection-close') closeHandlers.delete(handler as CloseHandler);
      if (name === 'sync') syncHandlers.delete(handler as SyncHandler);
    },
    emitClose(event: { code: number; reason?: string } | null) {
      for (const h of [...closeHandlers]) h(event as CloseEvent | null);
    },
    emitSync() {
      for (const h of [...syncHandlers]) h(true);
    },
    closeHandlerCount: () => closeHandlers.size,
    syncHandlerCount: () => syncHandlers.size,
  };
}

function mintResult(ticket: string): MintResult {
  return { ticket, expiresAtMs: Date.now() + TTL_MS };
}

describe('attachTicketRefresh', () => {
  let provider: ReturnType<typeof makeProvider>;
  let handle: TicketRefreshHandle | null = null;
  let terminal: Mock<(info: TerminalInfo) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = makeProvider();
    terminal = vi.fn<(info: TerminalInfo) => void>();
    handle = null;
  });

  afterEach(() => {
    handle?.detach();
    vi.useRealTimers();
  });

  function attach(mint: () => Promise<MintResult>, extra?: { freshWindowMs?: number }) {
    handle = attachTicketRefresh(provider, mintResult('t0'), {
      mint,
      onTerminal: terminal,
      ...extra,
    });
    return handle;
  }

  it('proactively re-mints at half-TTL and updates provider.params.ticket', async () => {
    let n = 0;
    const mint = vi.fn(() => Promise.resolve(mintResult(`t${++n}`)));
    attach(mint);

    await vi.advanceTimersByTimeAsync(TTL_MS / 2);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(provider.params.ticket).toBe('t1');

    // Reschedules itself off the new mint's TTL.
    await vi.advanceTimersByTimeAsync(TTL_MS / 2);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(provider.params.ticket).toBe('t2');
    expect(terminal).not.toHaveBeenCalled();
  });

  it('re-mints on a stale-ticket 1008 without latching', async () => {
    let n = 0;
    const mint = vi.fn(() => Promise.resolve(mintResult(`t${++n}`)));
    attach(mint);

    // Move the clock past the fresh window without firing the
    // half-TTL timer, then fail a reconnect with 1008.
    vi.setSystemTime(Date.now() + 40_000);
    provider.emitClose({ code: 1008, reason: 'invalid_ticket' });
    await vi.advanceTimersByTimeAsync(0);

    expect(mint).toHaveBeenCalledTimes(1);
    expect(provider.params.ticket).toBe('t1');
    expect(terminal).not.toHaveBeenCalled();
    expect(provider.shouldConnect).toBe(true);
  });

  it('tolerates a 1008 that lands while a mint is in flight', async () => {
    let release: ((r: MintResult) => void) | null = null;
    const mint = vi.fn(
      () =>
        new Promise<MintResult>((resolve) => {
          release = resolve;
        }),
    );
    attach(mint);

    vi.setSystemTime(Date.now() + 40_000);
    provider.emitClose({ code: 1008, reason: 'invalid_ticket' });
    expect(mint).toHaveBeenCalledTimes(1);
    // y-websocket's fast re-dial still carried the stale ticket and
    // fails again while the mint is pending — must not latch and
    // must not start a second mint.
    provider.emitClose({ code: 1008, reason: 'invalid_ticket' });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(terminal).not.toHaveBeenCalled();

    release!(mintResult('t1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.params.ticket).toBe('t1');
  });

  it('latches terminal only after two fresh-ticket 1008s', async () => {
    let n = 0;
    const mint = vi.fn(() => Promise.resolve(mintResult(`t${++n}`)));
    attach(mint);

    // First 1008 against the just-minted initial ticket: one strike,
    // re-mint, keep retrying (it could be a dial that started with an
    // older ticket).
    provider.emitClose({ code: 1008, reason: 'forbidden' });
    await vi.advanceTimersByTimeAsync(0);
    expect(terminal).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledTimes(1);

    // Second fresh rejection: the re-minted ticket was refused too —
    // real auth failure, stop for good.
    provider.emitClose({ code: 1008, reason: 'forbidden' });
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith({ reason: 'forbidden', closeCode: 1008 });
    expect(provider.shouldConnect).toBe(false);
    expect(provider.disconnectCalls).toBe(1);

    // Latched: further closes do nothing.
    provider.emitClose({ code: 1008, reason: 'forbidden' });
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('a proven connection (sync) resets the fresh-strike counter', async () => {
    let n = 0;
    const mint = vi.fn(() => Promise.resolve(mintResult(`t${++n}`)));
    attach(mint);

    provider.emitClose({ code: 1008, reason: 'invalid_ticket' });
    await vi.advanceTimersByTimeAsync(0);
    provider.emitSync(); // reconnected and authenticated

    // Hours later (well past fresh window), a transient 1008 → re-mint;
    // then a fresh-looking one right after → still only strike one.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    provider.emitClose({ code: 1008, reason: 'invalid_ticket' });
    await vi.advanceTimersByTimeAsync(0);
    provider.emitClose({ code: 1008, reason: 'invalid_ticket' });
    expect(terminal).not.toHaveBeenCalled();
  });

  it('stops quietly when the mint returns 401', async () => {
    const mint = vi.fn(() =>
      Promise.reject(new ApiRequestError(401, 'unauthenticated', 'Not signed in')),
    );
    attach(mint);

    await vi.advanceTimersByTimeAsync(TTL_MS / 2);
    expect(terminal).not.toHaveBeenCalled();
    expect(provider.shouldConnect).toBe(false);
    expect(provider.disconnectCalls).toBe(1);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
  ])('goes terminal when the mint returns %i', async (status, code) => {
    const mint = vi.fn(() => Promise.reject(new ApiRequestError(status, code, 'nope')));
    attach(mint);

    await vi.advanceTimersByTimeAsync(TTL_MS / 2);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith({ reason: code, closeCode: 0 });
    expect(provider.shouldConnect).toBe(false);
  });

  it('retries after a network mint failure without dropping the ticket', async () => {
    let fail = true;
    let n = 0;
    const mint = vi.fn(() =>
      fail ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(mintResult(`t${++n}`)),
    );
    attach(mint);

    await vi.advanceTimersByTimeAsync(TTL_MS / 2);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(provider.params.ticket).toBe('t0'); // kept
    expect(terminal).not.toHaveBeenCalled();

    fail = false;
    await vi.advanceTimersByTimeAsync(15_000); // retry delay
    expect(mint).toHaveBeenCalledTimes(2);
    expect(provider.params.ticket).toBe('t1');
  });

  it('re-mints on tab wake when the ticket is past half its window', async () => {
    let n = 0;
    const mint = vi.fn(() => Promise.resolve(mintResult(`t${++n}`)));
    attach(mint);

    // Simulate a laptop-sleep gap: wall clock jumps, timers frozen.
    vi.setSystemTime(Date.now() + TTL_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(provider.params.ticket).toBe('t1');
  });

  it('detach clears timers and listeners', async () => {
    const mint = vi.fn(() => Promise.resolve(mintResult('t1')));
    const h = attach(mint);
    expect(provider.closeHandlerCount()).toBe(1);
    expect(provider.syncHandlerCount()).toBe(1);

    h.detach();
    expect(provider.closeHandlerCount()).toBe(0);
    expect(provider.syncHandlerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TTL_MS);
    expect(mint).not.toHaveBeenCalled();
    // detach (unlike terminal) leaves the provider itself alone — the
    // caller owns provider.destroy().
    expect(provider.shouldConnect).toBe(true);
    expect(provider.disconnectCalls).toBe(0);
  });
});
