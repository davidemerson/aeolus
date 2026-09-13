# 0010 — Postgres least-privilege migrator and TLS handling

- **Status**: accepted — §3 rewritten 2026-09-13: TLS is now chosen by
  `AEOLUS_DB_SSL` / `AEOLUS_DB_CA_FILE` rather than by the presence of
  one hard-coded provider CA bundle.
- **Date**: 2026-04-30

## Context

Aeolus should run against a Postgres role that owns its own tables and
nothing else. That is a normal posture for a managed database, and it is
what a careful operator will configure by hand: `CREATE` on the `public`
schema, and no more.

- ✓ `CREATE TABLE`, `CREATE INDEX`, `INSERT`, `SELECT` on `public` work
  — that is where the app's tables live.
- ✗ `CREATE SCHEMA` requires CREATE-on-database, which such a role does
  not have.
- ✗ `CREATE EXTENSION` requires superuser (or a provider's equivalent
  role), which such a role does not have.
- ✗ Some managed Postgres services reject unencrypted connections
  outright.

Three default-Postgres-tooling assumptions break against that role:

1. **drizzle-orm's `migrate()`** opens with
   `CREATE SCHEMA IF NOT EXISTS "drizzle"` for its
   `__drizzle_migrations` bookkeeping table. Even with `IF NOT EXISTS`,
   Postgres requires CREATE-on-database for the statement.
2. **drizzle-kit auto-generates** `CREATE EXTENSION IF NOT EXISTS
   pgcrypto;` defensively in the first migration file whenever the
   schema uses `gen_random_uuid()`.
3. **node-postgres** defaults to non-SSL connections, so against a
   server that requires TLS it fails with
   `no pg_hba.conf entry for host "…", no encryption` — and against a
   server that merely *permits* it, it silently does not use it.

The bundled compose stack does not hit any of these: its Postgres role
owns the database and the network is private. The decision below is
about what happens when an operator points `DATABASE_URL` somewhere
else, which is the case worth designing for.

## Decision

### 1. Replace `drizzle-orm/migrate` with a custom runner

`packages/db/src/migrate.ts` (140 lines) keeps drizzle's on-disk format
— per-tag `.sql` files plus `migrations/meta/_journal.json` — and the
same SHA-256 hashing algorithm, so switching back to the stock migrator
stays possible. It drives replay itself:

- bookkeeping in `public."__drizzle_migrations"` rather than a
  `drizzle` schema;
- statements split on drizzle's own `--> statement-breakpoint` marker;
- each migration applied inside a transaction, the whole replay wrapped
  in a session-level `pg_advisory_lock`, so concurrent boots across api,
  ws and worker serialize cleanly and exactly one wins each migration.

All three launchers call `runMigrations(connectionString)` before
opening their pools, so a fresh database is usable after a single
`docker compose up` with nothing else run by hand.

### 2. No `CREATE EXTENSION pgcrypto`

`gen_random_uuid()` has been built into Postgres since v13 and the
stack pins 16, so the line is unnecessary. It is absent from
`packages/db/migrations/`.

drizzle-kit re-emits it whenever migrations are regenerated from the
schema. A contributor running `drizzle-kit generate` has to strip it
again; there is no CI check for this, which is a deliberate
under-engineering of a documented gotcha.

### 3. TLS is the operator's statement of intent, not a guess

`poolSslFor(connectionString)` in `packages/db/src/index.ts` is the
single source of truth for TLS across api, ws, worker, the migration
runner and both pg-boss instances (which connect through their own
pools, so they are passed `ssl: poolSslFor(…)` explicitly).

`AEOLUS_DB_SSL` says what to do:

- `disable` — no TLS. What the bundled Postgres uses, on a private
  compose network.
- `require` — TLS, certificate not verified. Stops a passive listener,
  not an active one.
- `verify` — TLS with the chain checked against the bundle at
  `AEOLUS_DB_CA_FILE` (default `/etc/ssl/certs/aeolus-db-ca.pem`). The
  right answer for a managed database across a network. Missing bundle
  throws, naming the path it looked at.

Unset, it infers: loopback and the compose service hostnames
(`@localhost`, `@127.0.0.1`, `@::1`, `@postgres:`, `@db:`) get no TLS;
a CA bundle on disk means verify; and anything else **throws in
production** rather than guessing, and warns once (with the password
redacted) outside it.

No provider CA bundle is baked into any image. `Dockerfile.worker` says
so in a comment: mount your provider's root bundle and point
`AEOLUS_DB_CA_FILE` at it.

## Consequences

**Positive**

- The three processes boot cleanly against a role with CREATE on
  `public` and nothing else. No privilege escalation is needed to
  install Aeolus.
- Migration replay is idempotent and concurrency-safe.
- A deployment reaching a database over a network cannot end up
  silently unverified: it either says what it wants or fails to start.
- The laptop case is unchanged and needs no configuration.

**Negative / accepted trade-offs**

- The custom migrator is one more piece of code to maintain. It is
  tightly scoped — read journal, take advisory lock, replay missing
  migrations, mark them applied — and the alternative is telling every
  operator to grant CREATE-on-database.
- `drizzle-kit migrate` (the CLI) will not work against a restricted
  role; it still tries to `CREATE SCHEMA`. That is fine: the CLI is
  dev-only, and the integration tests use testcontainers where the
  connection user is unrestricted.
- A contributor regenerating migrations may re-introduce
  `CREATE EXTENSION pgcrypto`.

## Pointers

- Custom runner: [`packages/db/src/migrate.ts`](../../packages/db/src/migrate.ts)
- TLS helper: [`packages/db/src/index.ts`](../../packages/db/src/index.ts)
  (`poolSslFor`)
- The `AEOLUS_DB_SSL` / `AEOLUS_DB_CA_FILE` comments an operator reads
  first: [`.env.example`](../../.env.example) § Database
