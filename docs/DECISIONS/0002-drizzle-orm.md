# 0002 — Drizzle ORM for Postgres access

- **Date**: 2026-04-14
- **Status**: Accepted
- **Phase**: 02 (database schema + migrations + test harness)

## Context

Aeolus needs a typed, migration-driven way to talk to
Postgres from TypeScript. The options considered were raw SQL with
`pg` + hand-written migrations, Drizzle ORM, Prisma, Kysely, and
TypeORM. The baseline requirements:

- Strict TypeScript types that reflect the schema without a separate
  codegen runtime.
- First-class Postgres feature support (UUID, `bytea`, `timestamptz`,
  `text[]`, check constraints) — no feature gating by the ORM.
- Migration tooling that emits plain SQL we can review in PRs.
- No heavyweight runtime or separate schema DSL in its own language.

## Decision

Use [Drizzle ORM](https://orm.drizzle.team) (`drizzle-orm` +
`drizzle-kit`). Schema lives in `packages/db/src/schema.ts` using
`pgTable` helpers; `drizzle-kit generate` produces SQL migrations
into `packages/db/migrations/`; `packages/db/src/migrate.ts` applies
them via `drizzle-orm/node-postgres/migrator`.

## Consequences

- **Pro**: schema is authored in TypeScript with full type inference
  (no schema DSL, no codegen step beyond `drizzle-kit generate`).
- **Pro**: generated migrations are plain, reviewable SQL — no
  opaque `shadow database` step.
- **Pro**: Drizzle leaves raw SQL as a first-class escape hatch
  (`sql\`…\``), which we already use for check constraints and will
  use for more complex queries later (Yjs update log, quota
  windowing).
- **Con**: smaller ecosystem than Prisma; fewer third-party
  integrations. We accept this because the surface area is small — one
  Postgres, one schema file, no second datastore.
- **Con**: Drizzle's migration runner does not (yet) support the
  equivalent of Prisma's `db push` for local experimentation. We
  compensate with the compose stack's Postgres and
  `pnpm --filter @aeolus/db migrate`.
- Prisma, Kysely, and TypeORM are explicitly rejected:
  - **Prisma** — Rust-based engine, separate schema language,
    heavier runtime footprint than we need, and its migration
    generator requires a shadow database which complicates CI.
  - **Kysely** — excellent query builder but has no opinion on
    schema/migration authoring; we would end up hand-rolling what
    Drizzle already ships.
  - **TypeORM** — decorator-driven, weaker TS inference, active
    maintenance concerns.

## Follow-ups

- Phase 03 (API bootstrap) wires `db()` from `@aeolus/db` into
  Fastify request scope.
- Phase 06 (y-websocket) uses the `doc_updates` table via Drizzle
  and owns the snapshot/compaction loop.
- Row-level security was considered against the application-layer ACL
  and not adopted: the five-role document model in
  [`0003`](0003-acl-404-vs-403.md) is enforced in one place
  (`packages/auth/src/acl.ts`, re-exported through `apps/api/src/acl.ts` and called from the service layer), which is easier to test
  exhaustively than a set of policies spread across tables.
