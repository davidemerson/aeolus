// Per-route budgets for the browser plane. The `/api/v1` plane has had a
// global limiter since it shipped; the cookie plane had none, so these four
// were unmetered: the LLM spend path, sign-in, credential minting, and the
// WebSocket ticket mint (ADR 0025).
//
// Keyed on client IP, which is only as good as what the app is told: behind a
// reverse proxy every request carries the proxy's address unless
// AEOLUS_TRUST_PROXY names how many hops to skip. Set it (see the deployment
// notes) or this is one shared bucket for everyone.
//
// The limiter runs before authentication, so a per-user key is not available
// here. For sign-in that is the point — it is the layer that slows a spray
// across many accounts, while the per-account lockout in
// services/credentials.ts handles a single account under attack.

export interface RouteRateLimit {
  max: number;
  timeWindow: string;
}

export type BrowserRateLimits = Record<
  'assist' | 'login' | 'tokenMint' | 'wsTicket',
  RouteRateLimit
>;

export const BROWSER_RATE_LIMITS: BrowserRateLimits = {
  /** POST /api/ai/assist — one Claude request per two seconds, sustained. */
  assist: { max: 30, timeWindow: '1 minute' },
  /**
   * POST /api/auth/login and POST /api/auth/passphrase. Generous enough for a
   * household or a small team sharing one address, tight enough that an
   * online guessing run is measured in years rather than hours. The
   * ten-failure account lockout is the other half of this.
   */
  login: { max: 30, timeWindow: '1 minute' },
  /**
   * POST /api/tokens — minting a long-lived credential. 30, not 10: the
   * integration suites mint one per test from one address, and an admin
   * setting up a team does much the same.
   */
  tokenMint: { max: 30, timeWindow: '1 minute' },
  /** POST /api/ws/ticket — the SPA re-mints at half-TTL and on reconnect. */
  wsTicket: { max: 60, timeWindow: '1 minute' },
};

/** The house envelope for a 429, shared with the v1 plane's builder. */
export function rateLimitedResponse(max: number, after: string) {
  return {
    statusCode: 429,
    error: 'rate_limited',
    message: `Rate limit exceeded: ${max} requests per ${after}`,
  };
}
