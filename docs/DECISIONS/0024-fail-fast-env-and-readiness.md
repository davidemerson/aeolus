# 0024 — Required configuration fails the boot; readiness is a separate probe

- **Status**: accepted — the variable list and the shutdown numbers were
  re-checked against the code on 2026-09-13; two corrections are marked
  below.
- **Date**: 2026-09-13
- **Deciders**: David Emerson (polish-pass decision, 2026-09-13)
- **Supersedes/relates**: [`0010`](0010-postgres-least-privilege-migrator.md)
  (the database TLS branch this made fail loudly);
  [`0027`](0027-single-origin-compose-topology.md) (the compose stack
  these variables are set from)

## Context

Until 2026-09-13 the api and ws launchers filled in a missing
`DATABASE_URL` with a localhost DSN and a missing `AEOLUS_COOKIE_SECRET`
with the literal `dev-cookie-secret-change-me`. A deployed container
whose secret failed to resolve would boot, answer `/healthz` 200, and
sign session cookies with a constant published in this repository.
`poolSslFor` had the same shape: with nothing to verify against it
connected with `rejectUnauthorized: false` and logged nothing. The
worker already refused to start without `DATABASE_URL` and
`AEOLUS_S3_BUCKET`; the three processes disagreed with each other.

Three further findings from the same review:

- The api launcher passed `logger: process.env.AEOLUS_LOG === '1'` —
  always a boolean — so `buildServer`'s
  `deps.logger ?? NODE_ENV === 'production'` never fell back, and
  production error logging stayed off despite the comment beside it
  saying it was on. `AEOLUS_LOG` is set nowhere.
- `/healthz` on every process is unconditional by design: a health check
  that fails on a database blip drains the container that was about to
  recover. But nothing answered the *other* question — can this process
  reach Postgres and the blob store right now — so a container with a
  dead pool looked identical to a healthy one until someone compiled.
- The worker's `close()` only unsubscribed from pg-boss; `process.exit`
  then killed the engines mid-compile and left `compile_results` rows at
  `running` forever.

## Decision

1. **A variable the process cannot run without is a boot failure in
   production.** `requireEnv(name, devDefault?)`
   (`packages/db/src/env.ts`) returns the value, falls back to
   `devDefault` only when `NODE_ENV` is not `production`, and otherwise
   throws `MissingEnvError` naming the variable.

   | Process | Required | Dev fallback |
   | --- | --- | --- |
   | api | `DATABASE_URL`, `AEOLUS_COOKIE_SECRET` | yes — a localhost DSN and the dev secret |
   | ws | `DATABASE_URL`, `AEOLUS_COOKIE_SECRET` | yes — the same two |
   | worker | `DATABASE_URL`, `AEOLUS_S3_BUCKET` | **no** — required in every environment, as it always has been |

   Beyond `requireEnv`: `blobStoreFromEnv()` (`@aeolus/crdt`) throws in
   production when `AEOLUS_S3_BUCKET` is unset rather than handing back
   an in-memory store, and `poolSslFor` throws in production when it
   cannot tell what TLS was meant ([`0010`](0010-postgres-least-privilege-migrator.md)).

   **`AEOLUS_PUBLIC_BASE_URL` is deliberately not on that list**, even
   though `.env.example` lists it under "Required". The ws launcher
   required it briefly and then stopped: a deployment that had never
   carried the variable crash-looped on the new version while the old
   one kept serving. It is now optional with a warning
   (`AEOLUS_PUBLIC_BASE_URL is not set: cookie-path upgrades are
   accepted from any Origin`), and the api defaults it to
   `http://localhost:5173`. It is required for *correct* behaviour and
   not for booting — an operator can read a warning; they cannot read a
   container that will not start.

2. **Flags that feed a downstream default are read as
   `boolean | undefined`.** `envFlagOrUndefined('AEOLUS_LOG')` leaves
   the Fastify logger default intact; production now logs errors.

3. **`/readyz` exists on api and ws; health checks stay on
   `/healthz`.** api's probe runs `select 1` and round-trips one probe
   object (`_readyz/api-<pid>`, written once per process — an
   object-scoped credential answers 403 rather than a clean miss for a
   key that does not exist, so the probe writes a real object rather
   than asking whether the bucket answers). Its result is cached for 30
   seconds. ws's probe checks the pool and that the `aeolus_room_evict`
   LISTEN client is alive, and is **not** cached. The compose stack's
   api healthcheck points at `/healthz`, and pointing anything at
   `/readyz` is the operator's decision, not the default.

4. **Shutdown is bounded and drains.** Each launcher installs `once`
   signal handlers and exits 1 on its own rather than hanging: api and
   ws after 25 s, the worker after 28 s, with the worker first waiting
   up to `drainTimeoutMs` (25 s) for in-flight compiles.

5. **One JSON line per event.** ws gets a pino logger
   (`apps/ws/src/log.ts`); room persist failures, upgrade errors and the
   LISTEN client carry structured fields. api's request id is the
   `x-request-id` header when a proxy set one and a UUID otherwise —
   *(corrected 2026-09-13: this previously read a vendor-specific
   tracing header)* — so an error line can be joined to a proxy access
   log. The two remaining stderr sites in api (`audit.ts`, `blob-gc.ts`)
   and the worker's default error sink emit JSON.

## Consequences

- A misconfigured deployment fails at start with the variable named in
  the container's log, instead of running with a public secret.
- Laptop boots are unchanged: without `NODE_ENV=production` the dev
  defaults still apply and no `.env` file is needed for `pnpm dev`. The
  compose stack sets `NODE_ENV=production` in every image, so the strict
  path is what an operator actually gets.
- **The drain budget is longer than the container runtime's default
  grace period.** `docker compose stop` sends SIGTERM and SIGKILLs after
  10 seconds; the worker wants up to 25. `docker-compose.yml` sets no
  `stop_grace_period`, so a worker stopped mid-compile is killed before
  it finishes draining and leaves exactly the `running` row this
  decision set out to prevent. Raising `stop_grace_period` on the worker
  service to at least 30 s is what makes point 4 true in the shipped
  stack.
- The ws cookie-fallback upgrade checks the `Origin` header against
  `AEOLUS_PUBLIC_BASE_URL`. A WebSocket upgrade is not subject to CORS
  and carries the session cookie, so before this any page could open an
  authenticated Yjs socket from a signed-in browser. Requests with no
  `Origin` (non-browser clients) and the ticket path are unaffected —
  and, per point 1, so is an install that never set the variable.
- `pg_notify('aeolus_compile_events', …)` on every compile is gone. The
  ws relay that consumed it was removed when the UI moved to polling,
  and `apps/ws` no longer depends on `@aeolus/compile-worker`.
- Non-engine compile failures (blob store, database) reach the author as
  one generic sentence (`INTERNAL_COMPILE_FAILURE`); the underlying
  message goes to the worker log. Engine output and launch failures are
  unchanged.

## Verification

`packages/db/src/env.test.ts` (`requireEnv` / `envFlagOrUndefined` /
`poolSslFor` branches), `tests/integration/healthz.test.ts` (`/readyz`
503 with the database down), `tests/integration/readyz.test.ts` (200
against a real database; one probe object; a cached second call),
`tests/integration/ws.tickets.test.ts` (ws `/readyz`),
`tests/integration/worker.drain.test.ts` (a sleeping fake engine;
`close()` returns only after the row is terminal).
