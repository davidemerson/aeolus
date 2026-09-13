# 0021 — A service layer, extracted one domain at a time

- **Status**: accepted — enforced 2026-09-13: the last route-level writes now go through the service layer. Sign-in and passphrase changes call `services/credentials.ts`; the bot-session and `/dev/users` upserts call `ensureUserByEmail` in `services/users.ts`; the diagnostics smoke compile's doc create / enqueue / soft-delete call `services/docs.ts` and `services/compile.ts`; the sign-out and token audit rows go through `ServiceContext.audit`. `ws` reads `is_admin` through the shared schema. No route module inserts or updates a table directly.
- **Date**: 2026-09-04
- **Context for**: [`0019`](0019-machine-api-plane.md), which added a second
  route plane and therefore created the problem this solves.

## Context

Before `/api/v1`, Aeolus had one route plane and no service layer. Every
document, file, template, checkpoint and compile operation was written
inline in its route handler: inline Drizzle, inline transaction, inline
zod parse, inline error mapping, inline serializer. `routes/docs.ts` was
474 lines; `files.ts` 611; `checkpoints.ts` 542.

That was fine with one caller. With two, it is a fork in the road: either
`/api/v1` re-implements each operation, or the operation moves somewhere
both planes can call.

The repo already shows what the first option costs. `routes/assets.ts` and
`routes/files.ts` are two upload surfaces with duplicated MIME tables,
duplicated size caps and duplicated shared-blob delete guards, and
`files.ts` has carried a "phase 4 of issue #9 will collapse these" comment
since the day it was written. A third copy of
`assertCanWrite` → `validatePath` → `touchProject` → 23505-mapping would
drift the same way — and here drift is a *correctness* bug, because the
status codes are ADR-governed (0003's 404-not-403, 0018's 204).

## Decision

**Extract per domain, and rewrite the browser-plane route as a thin caller
in the same change, before any v1 route for that domain exists.**

There is never a moment when two implementations of the same operation are
both live. That is the whole rule; everything below follows from it.

### The contract

```ts
service(ctx: ServiceContext, actor: Actor, input): Promise<View>
```

- **No Fastify types below the service line.** A service never sees a
  `reply`, never picks a status code, never serialises. That is what makes
  it callable from both planes.
- **Errors are thrown, not mapped.** `DocNotFoundError`,
  `DocForbiddenError` and `DocArchivedError` already carry `statusCode` and
  `code`, and both planes' error handlers read them — so
  `throw new DocNotFoundError()` produces byte-identical output to the
  hand-written `notFound(reply)` it replaces. This is why the copy-pasted
  `try { assertCanRead } catch { if (err instanceof …) }` ladder in seven
  files can simply be deleted rather than moved.
- **`ctx.audit` is pre-bound** with the request's IP, user-agent and actor.
  A call site names only what happened — and a token-driven change is
  attributed as one automatically, so v1 needs no second audit vocabulary.
- **`Actor` carries `via`**, so the two planes are distinguishable in the
  audit log without being distinguishable anywhere else.

### The review rule

**The existing integration suites verify the refactor for free**, because
they drive the real server over HTTP. A pure extraction changes none of
them.

So: *if an extraction PR needs an existing test's assertions edited, it
was not pure.* That is the check to apply in review, and it is stronger
than reading the diff. The documents extraction cut `routes/docs.ts` from
474 lines to 184 with all 47 existing tests passing untouched.

### What it also buys

Each extraction is an opportunity to collapse something that was already
duplicated, without that being a separate risky PR. The documents pass took
`resolveRole` → "none is 404, non-owner is 403" — written out five times in
`routes/docs.ts` — into `assertCanAdminister` in the ACL engine, where it
sits next to `assertCanRead` and `assertCanWrite` and is unit-testable.

## Consequences

- Two planes, one implementation. The `route-acl.test.ts` parallel block
  asserts they answer the ACL identically, case by case, side by side — so
  a divergence fails one file with both answers visible.
- Each domain PR is 400–900 lines, mostly moved. Reviewable.
- Ordering is forced: a domain's v1 routes cannot land before its
  extraction, because the extraction is what they call.
- The extraction is **complete**: documents, files (+ assets), templates,
  compile (+ zip), checkpoints (+ project checkpoints), users, audit events,
  Claude-assist and the collaboration ticket. Roughly 3,600 lines of inline
  route logic became a service layer both planes call, and no domain is
  implemented twice.
- **A streaming service needs one addition to the signature, not an
  exception to it.** `services/assist.ts` takes `(ctx, actor, input, sink)`.
  Everything that can still be an HTTP status — the ACL, the quota, the spend
  cap, a missing key — is checked and thrown *before* `sink.open()`, which is
  the moment the status line is committed; after it, a failure is reported
  through `sink.failed()` and the caller decides how to say so on the wire.
  The service still names no status code and still imports no Fastify type.
  Both planes pass the same sink implementation, so the SSE grammar the editor
  consumes is the one `docs/API.md` documents.

## Alternatives considered

**Extract everything first, in one PR.** Rejected on reviewability: ~3,600
lines across eight files, all the risk front-loaded before any feature
exists, and it would force extracting things v1 does not need (the dev
routes, the smoke-compile).

**Let `/api/v1` re-implement each domain.** Rejected — see Context. It is
the mistake the repo has already made once with `assets.ts` / `files.ts`,
and is still living with.

**Extract lazily, only when a second caller appears.** This *is* that, with
the "same PR" rule attached. Without the rule it degrades into the previous
option, because the pressure at the time is always to ship the v1 route
first and tidy the browser one later.
