# 0004 — E2E stack orchestration: testcontainers + in-process servers, not docker compose

- **Date**: 2026-04-14
- **Status**: accepted — amended 2026-09-13: Redis was removed from the
  stack (sessions and the spend ledger are Postgres rows), and the
  compose file described below is now the shipped deployment rather than
  a test fixture. The decision is unchanged.

## Context

A new developer should be able to `pnpm install`, run `pnpm test:e2e`,
and get a reproducible full-stack run on a laptop and in CI.

Three ways to get there:

1. **Pure docker compose.** Build images for `api`, `ws` and `web`,
   bring them up, and have the Playwright test connect to the published
   port.
2. **Testcontainers + in-process api/ws/worker + spawned Vite.** Boot
   Postgres through testcontainers — the same mechanism every
   integration test already uses — start the services in-process via
   their exported factories, and spawn Vite as a child process. Clean up
   in `globalTeardown`.
3. **Hybrid.** Compose for the database; spawned node processes for the
   services.

## Decision

Option 2. `tests/e2e/global-setup.ts` does the following, and
`tests/e2e/global-teardown.ts` unwinds it:

- Start a `postgres:16-alpine` container via
  `@testcontainers/postgresql`.
- Run the migrations with `runMigrations(databaseUrl)`.
- Call `buildServer({ db, blobs: MemoryBlobStore(), … })` and listen on
  `localhost:4000`.
- Call `createWsServer({ db, dbPool, blobs, cookieSecret })` and listen
  on `localhost:4001`.
- Call `createCompileWorker({ db, boss, blobs, tectonicBin, typstBin, … })`
  in the same process, so a compile assertion exercises the real engine.
- Spawn `vite --host localhost --port 5173` with `AEOLUS_API_URL` and
  `AEOLUS_WS_URL` pointed at the in-process servers.
- Poll the Vite root and the api's `/healthz` before letting the suite
  start. `/healthz`, not a route under `/api`, because the wait treats
  anything under 500 as ready — and every api route lives under `/api`,
  so a probe of `/` would have returned the instant the socket accepted
  and proved nothing about the routes being registered.

The one blob store the suite uses is `MemoryBlobStore`, shared by all
three services because they are one process. That is exactly the
condition [`0027`](0027-single-origin-compose-topology.md) says a real
deployment must not be in — and it is safe here only because there is no
process boundary for the snapshots to fall through.

## Why not pure docker compose

- **Reproduces the integration-test topology.** Every integration suite
  already boots Postgres through testcontainers; the E2E test reusing it
  means "how do I boot the DB?" has one answer across the whole test
  pyramid.
- **No image-build latency.** A cold `docker compose build` against a
  multi-stage image that pulls Node, runs `pnpm install --frozen-lockfile`
  and rebuilds on every source change makes the inner loop painful.
  Testcontainers plus in-process servers start in seconds once
  `pnpm install` is warm.
- **Cache-friendliness in CI.** A single pnpm store serves every job.
  Dockerised services would need a separate image-build cache or a slow
  cold rebuild.
- **Single node_modules.** In a pnpm workspace, `buildServer()` is a
  named export. Containerising would force a second package install
  inside every image.

## What the compose file is for instead

`docker-compose.yml` at the repository root is how an operator runs
Aeolus — six services, one published port, described in
[`0027`](0027-single-origin-compose-topology.md). It is not part of the
test path and the E2E suite never starts it.

That means the two paths can drift, and the drift is not free: the
compose stack puts api, ws and worker in separate containers behind
Caddy, while the E2E suite runs them in one process on three ports. A
bug that only appears across a process boundary — a blob store that is
not shared, a cookie that does not reach the WebSocket — is invisible to
this suite by construction. Both of those have happened, and both are
why 0027 exists.

## Consequences

- The E2E test needs a reachable Docker daemon, exactly as the
  integration tests do. A machine that can run `pnpm test` can run
  `pnpm test:e2e`.
- Any future service added to the stack grows **two** boot paths:
  in-process for the E2E suite, and a compose service for the real
  deployment. This is cheap — every `apps/*` service already has a
  `src/bin/` entrypoint for the container case.
- Cross-process failures are out of this suite's reach. Catching them is
  a manual `docker compose up` before a release, not something the test
  pyramid does for you.
