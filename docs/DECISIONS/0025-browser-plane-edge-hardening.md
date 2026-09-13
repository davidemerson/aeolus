# 0025 — Security headers, a report-only CSP, and rate limits on the browser plane

- **Status**: accepted — re-checked 2026-09-13 against the code; the
  numbers and the two rationales that had drifted are corrected below.
- **Date**: 2026-09-13
- **Deciders**: David Emerson (polish-pass decision, 2026-09-13)
- **Supersedes/relates**: [`0019`](0019-machine-api-plane.md) (the v1
  plane's limiter, whose envelope this reuses);
  [`0024`](0024-fail-fast-env-and-readiness.md) (boot-time hardening,
  same pass); [`0022`](0022-sandbox-compile-engine-with-landlock.md)
  (the observe-then-enforce rollout this borrows)

## Context

Until 2026-09-13 the only security header the api sent was the
`frame-ancestors` CSP that makes iframe embedding configurable. No
`X-Content-Type-Options`, no `Referrer-Policy`, no
`Strict-Transport-Security`, and no policy on what the SPA may load or
connect to — on the server that serves the SPA shell.

The `/api/v1` plane has had a global rate limiter since it shipped; the
cookie plane had none. Four routes were unmetered: `POST /api/ai/assist`
(the LLM spend path), sign-in, `POST /api/tokens` (a durable credential)
and `POST /api/ws/ticket`.

The two error handlers put a thrown error's `code` on the wire verbatim,
so a body over Fastify's default 1 MiB limit answered
`error: "FST_ERR_CTP_BODY_TOO_LARGE"` — and on the documented plane that
code is in no route's schema, so the serializer turned it into a 500.
Twelve route modules carried their own copy of the `{ error, message }`
envelope helper.

Several responses said too much: the admin diagnostics page rendered raw
Postgres and fetch error strings, and forwarded the operator's entire
`Cookie` header to whatever `AEOLUS_WS_INTERNAL_URL` named; and the
assist SSE stream relayed the Anthropic SDK's error text to the author.

## Decision

1. **Headers via `@fastify/helmet`**, with two deliberate departures
   from its defaults:
   - `X-Frame-Options` **off**. It has no cross-origin allow-list, so a
     stray `SAMEORIGIN` would override whatever `AEOLUS_FRAME_ANCESTORS`
     permits. `frame-ancestors` is the only framing policy.
   - `Cross-Origin-Opener-Policy: same-origin-allow-popups`. *(Corrected
     2026-09-13: the reason is the PDF preview, which opens in a new tab
     and reaches back through `window.opener`; a strict COOP severs
     that. The earlier text gave a sign-in popup as the reason, which no
     longer exists.)*

   HSTS only when cookies are `Secure` — i.e. when the operator has
   said, via `AEOLUS_COOKIE_SECURE`, that there is https to insist on.
   Sending HSTS from a plain-http install would lock a browser out of a
   site that has no https to fall forward to.

2. **The full CSP ships Report-Only first.** The E2E suite drives the
   SPA from the Vite dev server, so an enforced policy from the api
   would go live untested. `Content-Security-Policy-Report-Only` carries
   the candidate policy — `default-src 'self'`; `style-src
   'unsafe-inline'` for CodeMirror and Tailwind's runtime; `worker-src
   blob:` for pdf.js; `connect-src 'self'` plus the origin of
   `AEOLUS_WS_URL` when ws is on a different origin, plus
   `ws://localhost:*` and `http://localhost:*` for the dev server — with
   `report-uri /api/csp-report`. Violations are logged at warn with
   directive, blocked URI and document, and nothing else. The enforcing
   header is the existing `frame-ancestors` one, unchanged. Enforce once
   the log has been quiet through real use.

   *(Corrected 2026-09-13: `connect-src` was previously described as
   carrying a fixed wildcard hostname. It is computed from the
   deployment's own configuration — `connectSrcFor(AEOLUS_WS_URL)` in
   `apps/api/src/bin/server.ts` — and in the single-origin compose stack
   it contributes nothing, because ws is the same origin.)*

3. **Per-route rate limits on the browser plane**, opt-in via
   `config.rateLimit` in a second scope-encapsulated
   `@fastify/rate-limit` registration. `BROWSER_RATE_LIMITS` in
   `apps/api/src/middleware/rate-limits.ts`: assist 30/min, sign-in
   30/min, token mint 30/min, ws ticket 60/min, keyed on client IP. Same
   429 envelope as v1.

   The limiter runs **before** authentication, so a per-user key is not
   available to it. For sign-in that is the point: this is the layer
   that slows a spray across many accounts, and the ten-failure
   per-account lockout in `services/credentials.ts`
   ([`0026`](0026-local-passphrase-authentication.md)) is the layer that
   handles one account under attack. Neither replaces the other.

   The IP key is only as good as what the app is told. Behind a reverse
   proxy, every request carries the proxy's address unless
   `AEOLUS_TRUST_PROXY` names the proxy — the compose stack sets
   `uniquelocal`. Unset behind a proxy, these four budgets are one
   bucket shared by everybody.

4. **One error envelope, one mapping.**
   `apps/api/src/middleware/reply-errors.ts` holds `sendError` /
   `notFound` (the twelve copies are gone) and `publicError()`, which
   both error handlers use: deliberate domain errors pass through,
   Fastify's `FST_ERR_*` and http-errors-shaped errors map to house
   codes (`payload_too_large`, `unsupported_media_type`,
   `invalid_body`), and an unexpected 5xx says `internal_error`. The
   body limit is 5 MiB; multipart allows one file and a handful of
   fields.

5. **Say less.** Diagnostics returns generic strings and logs the cause.
   `wsInternalBase()` requires `AEOLUS_WS_INTERNAL_URL` to be an http(s)
   URL with a host and no embedded credentials, and only the session
   cookie travels to it — *(corrected 2026-09-13: the check was
   previously described as requiring a specific parent domain; it is a
   shape check, and the ADR text now says what the code does)*. The
   assist stream reports `ASSIST_FAILED_MESSAGE` and logs the SDK error
   under `assist: upstream request failed`.

   Sign-out is `DELETE /api/me/session`, which destroys the session row
   server-side and clears the cookie. A state change on an unsafe method
   is not something a cross-site `<img>` or link can trigger; the route
   is also idempotent, so a client can fire it without special-casing an
   already-expired cookie.

## Consequences

- A client that branched on `FST_ERR_*` strings would break; none is
  known, and the codes were never documented.
- The assist error text an author sees is now one sentence; the SDK
  message is in the api log.
- Enforcing the CSP is a follow-up: swap `content-security-policy` to
  the full policy once `csp violation reported` has not appeared for a
  week of real use. If a violation does appear, the directive is in the
  log line.
- `@fastify/rate-limit` is registered twice, in two encapsulated scopes;
  neither sees the other's routes (`v1.ratelimit.test.ts` pins the v1
  side, `browser.edge.test.ts` the cookie side).
- The budgets are a `buildServer` dependency (`browserRateLimits`,
  default `BROWSER_RATE_LIMITS`), because the integration suites mint a
  token per test from one address and would trip the mint budget on
  their own; `v1.docs.test.ts` and `v1.admin.test.ts` raise it. A real
  deployment always runs the defaults — the launcher passes nothing.

## Verification

`tests/integration/healthz.test.ts` (headers on every response),
`tests/integration/browser.edge.test.ts` (the POST budgets, the CSP
report sink, 413 `payload_too_large`),
`tests/integration/me.session.test.ts` (sign-out),
`apps/api/src/middleware/reply-errors.test.ts`,
`apps/api/src/routes/admin-diagnostics.test.ts` (`wsInternalBase`).
