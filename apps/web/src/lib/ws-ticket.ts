import { ApiRequestError } from './api.js';

// Keeps a y-websocket provider's upgrade ticket fresh for the whole
// life of the connection. Tickets are 5-minute multi-use bearers
// minted by POST /api/ws/ticket; y-websocket rebuilds the upgrade URL
// from `provider.params` on every (re)connect, and upstream documents
// params as safe to mutate between connections — so re-minting is
// just `provider.params.ticket = fresh`. Without this, any reconnect
// after the TTL (deploy, laptop sleep, network blip, room eviction)
// presents an expired ticket and the server closes 1008
// invalid_ticket.
//
// Terminal-failure policy: a 1008 close only counts toward a real
// auth failure (access revoked, doc deleted) when it rejected a
// ticket the API vouched for moments ago — and even then it takes
// two fresh-ticket strikes with a re-mint in between, because a dial
// that STARTED with the old stale ticket can fail moments after a
// re-mint lands and would otherwise look fresh. A 1008 against a
// stale ticket just triggers a re-mint and lets y-websocket keep
// retrying. The strike counter resets on the provider's 'sync' event
// — the only auth-proven signal ('status: connected' fires before
// the server has authenticated the upgrade).

export interface MintResult {
  ticket: string;
  // Absolute wall-clock expiry (ms since epoch), from the mint
  // response's expires_at.
  expiresAtMs: number;
}

export interface TerminalInfo {
  reason: string;
  closeCode: number;
}

// Structural slice of y-websocket's WebsocketProvider — everything
// this module touches, and nothing more, so unit tests can pass a
// plain object.
export interface TicketProviderLike {
  params: { [key: string]: string };
  shouldConnect: boolean;
  disconnect(): void;
  on(name: 'connection-close', handler: (event: CloseEvent | null) => void): void;
  on(name: 'sync', handler: (isSynced: boolean) => void): void;
  off(name: 'connection-close', handler: (event: CloseEvent | null) => void): void;
  off(name: 'sync', handler: (isSynced: boolean) => void): void;
}

export interface AttachTicketRefreshOptions {
  mint(): Promise<MintResult>;
  // Called at most once, when the connection is genuinely
  // unrecoverable without a reload (fresh ticket rejected, or the
  // mint itself came back 403/404).
  onTerminal(info: TerminalInfo): void;
  // A ticket minted within this window is "fresh": a 1008 against it
  // means real auth failure, not staleness. Default 30s.
  freshWindowMs?: number;
  // Retry delay after a network/5xx mint failure. Default 15s.
  retryDelayMs?: number;
  // Test injection.
  now?(): number;
}

export interface TicketRefreshHandle {
  detach(): void;
}

export function attachTicketRefresh(
  provider: TicketProviderLike,
  initial: MintResult,
  opts: AttachTicketRefreshOptions,
): TicketRefreshHandle {
  const now = opts.now ?? (() => Date.now());
  const freshWindowMs = opts.freshWindowMs ?? 30_000;
  const retryDelayMs = opts.retryDelayMs ?? 15_000;

  let lastMintAt = now();
  // Floor the window so clock skew between the API host and this
  // machine can't produce a degenerate (or negative) refresh timer.
  let ttlMs = Math.max(initial.expiresAtMs - lastMintAt, 60_000);
  let mintInFlight: Promise<void> | null = null;
  let freshStrikes = 0;
  let stopped = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

  function clearRefreshTimer(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function scheduleRefresh(delayMs: number): void {
    clearRefreshTimer();
    if (stopped) return;
    refreshTimer = setTimeout(() => {
      void doMint();
    }, delayMs);
  }

  function detach(): void {
    stopped = true;
    clearRefreshTimer();
    provider.off('connection-close', onClose);
    provider.off('sync', onSync);
    if (hasDom) {
      window.removeEventListener('online', maybeRefresh);
      document.removeEventListener('visibilitychange', maybeRefresh);
    }
  }

  function stopProvider(): void {
    detach();
    provider.shouldConnect = false;
    provider.disconnect();
  }

  function terminal(info: TerminalInfo): void {
    if (stopped) return;
    stopProvider();
    opts.onTerminal(info);
  }

  function doMint(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (mintInFlight) return mintInFlight;
    mintInFlight = opts.mint().then(
      (result) => {
        mintInFlight = null;
        if (stopped) return;
        provider.params.ticket = result.ticket;
        lastMintAt = now();
        ttlMs = Math.max(result.expiresAtMs - lastMintAt, 60_000);
        scheduleRefresh(ttlMs / 2);
      },
      (err: unknown) => {
        mintInFlight = null;
        if (stopped) return;
        const status = err instanceof ApiRequestError ? err.status : undefined;
        if (status === 401) {
          // Session died. The global 401 hook (main.tsx) is already
          // redirecting to /login — stop the provider quietly instead
          // of racing it with a banner.
          stopProvider();
          return;
        }
        if (status === 403 || status === 404) {
          // Access revoked or doc deleted — unrecoverable, and we
          // learned it from the mint before any 1008 arrived.
          const code = err instanceof ApiRequestError ? err.code : 'auth_rejected';
          terminal({ reason: code, closeCode: 0 });
          return;
        }
        // Network / 5xx: keep the current ticket and retry shortly.
        // If it expires meanwhile, the 1008 path below re-mints again.
        scheduleRefresh(retryDelayMs);
      },
    );
    return mintInFlight;
  }

  const onClose = (event: CloseEvent | null): void => {
    if (stopped) return;
    const code = event?.code ?? 0;
    if (code === 1008) {
      // Fresh ticket rejected → the server refused credentials the
      // API just vouched for: counts toward a real auth failure. A
      // single fresh strike still re-mints and retries once, because
      // a dial that started with the old stale ticket can fail right
      // after a re-mint landed and be indistinguishable from a fresh
      // rejection. Stale ticket (or a mint already racing
      // y-websocket's fast re-dial) → re-mint, no strike.
      const fresh = now() - lastMintAt < freshWindowMs && !mintInFlight;
      if (fresh) {
        freshStrikes += 1;
        if (freshStrikes >= 2) {
          terminal({ reason: event?.reason || 'auth_rejected', closeCode: 1008 });
          return;
        }
      }
      void doMint();
      return;
    }
    // Every other close (1001 deploy, 1012 room_evicted, 1006 network,
    // 0/null client watchdog) is retryable and never latches. Re-mint
    // opportunistically when the ticket is past half its window —
    // covers laptop sleep, where the refresh timer was frozen.
    if (now() - lastMintAt > ttlMs / 2) void doMint();
  };

  const onSync = (): void => {
    // The server authenticated the upgrade and completed the sync
    // handshake — any earlier fresh-1008 was transient.
    freshStrikes = 0;
  };

  const maybeRefresh = (): void => {
    if (stopped) return;
    if (hasDom && document.visibilityState === 'hidden') return;
    if (now() - lastMintAt > ttlMs / 2) void doMint();
  };

  provider.on('connection-close', onClose);
  provider.on('sync', onSync);
  if (hasDom) {
    window.addEventListener('online', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);
  }
  scheduleRefresh(ttlMs / 2);

  return { detach };
}
