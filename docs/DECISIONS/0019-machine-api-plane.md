# 0019 — A versioned `/api/v1` machine plane, alongside the browser plane

- **Status**: accepted
- **Date**: 2026-09-04
- **Supersedes**: nothing. The unversioned `/api/*` browser plane is
  unchanged and stays the SPA's contract.
- **Companion**: [`0020-self-service-api-tokens.md`](0020-self-service-api-tokens.md)
  decides the credential; this decides the plane it authenticates to.

## Context

Aeolus has been a browser-only application. Every route authenticates
with the `aeolus_session` cookie, and that cookie **rotates on every
authenticated request**: `resolveSession` calls `sessions.touch()`,
which inserts a new row and rewinds the old one's idle marker so it dies
in ten seconds. A client that ignores `Set-Cookie` therefore gets
exactly one successful request per credential.

The consequence is that nothing can drive Aeolus programmatically. No CI
job that compiles a paper when a branch merges, no script that syncs a
chapter in from somewhere else, no agent that files a draft. The nearest
thing to a machine credential was `POST /api/admin/bot-session`, which
mints a non-rotating session and hands back a ready-to-paste
`cookie_header` — a debugging aid that happens to work, not a designed
one, and still admin-only and still a cookie.

## Decision

**A versioned `/api/v1/*` plane, in the same api process, on the same
host, registered as a sibling of the existing `/api` block.**

### Same origin, no new exposure

The same origin the SPA is already served from. No second hostname, no
second certificate, no extra route in the reverse proxy — Caddy sends
everything that is not `/ws` to the api process, and `/api/v1` is one
more prefix that process answers (see
[`0027`](0027-single-origin-compose-topology.md)). An operator turns
nothing on to get this plane; it is there the moment the api is.

What bounds it is therefore the credential and the document ACL, and
nothing else. That is stated plainly because it is easy to assume a
network boundary is doing some of the work, and on a self-hosted
install there may not be one.

**One warning for anyone putting a WAF in front of Aeolus.** A generic
OWASP CRS ruleset's local-file-inclusion body rule blocks
`\input{../shared/preamble.tex}` — a literal path-traversal sequence,
and also the ordinary way to build a multi-file LaTeX document. Since
multi-file projects are a headline feature, the common case is the one
that gets blocked. Either exempt Aeolus from that rule or do not put
the ruleset in front of it; do not conclude the API is broken.

### A sibling plugin, not a nested one

```ts
await app.register(async (api) => { /* the existing /api routes */ }, { prefix: '/api' });
await app.register(registerV1, { prefix: '/api/v1' });
```

The v1 plugin installs an `onRequest` auth hook, its own
`setNotFoundHandler`, its own `setErrorHandler`, and a rate limiter.
Fastify encapsulation is what keeps every one of those off the browser
plane. Nesting v1 inside the `/api` block would work *today*, but only
because that block happens to have no hooks of its own — an accident,
not a boundary.

`isApiPath()` already treats everything under `/api/` as an API path, so
unknown v1 paths were never going to get the SPA shell. That is now
pinned by a test rather than left to inspection.

### The gate covers the prefix, not the routes

The v1 plugin registers its own `setNotFoundHandler`. This is a
correctness fix rather than tidiness, and it was found by a test that
expected 403 and got 404.

Fastify runs a scope's `onRequest` hooks only for requests that reach
that scope, and a request matching no route never does. Without a
plugin-scoped not-found handler:

- `GET /api/v1/anything` answered **404 to an anonymous caller**, which
  tells them which routes exist before asking for a credential; and
- a read-scope token's `POST /api/v1/anything` answered 404 rather than
  meeting the scope gate.

Neither is a serious hole — the paths concerned have no handler — but
both mean the gate is not what it appears to be. With the handler
registered inside the plane, auth runs first and the plane answers
401/403 before it answers 404.

### Rate limiting lives here, not in the WAF

Per-credential, 120 requests per minute by default, keyed on
`sha256(bearer)` (never the credential itself) and falling back to
`request.ip`.

It cannot live at the edge. Every request reaches the api from the
reverse proxy, so a proxy-level IP rate rule meters the whole instance
as a single source. The forwarded-header alternative keys on
`X-Forwarded-For`, which a proxy *appends* to rather than replaces, so
the first entry is client-supplied and the bucket becomes
attacker-chosen. The app is the only place that knows who is actually
asking, because it is the only place that has resolved the credential.

`request.ip` — the fallback key for an unauthenticated request — is
itself only meaningful when `AEOLUS_TRUST_PROXY` names the proxy; see
[`0025`](0025-browser-plane-edge-hardening.md).

`@fastify/rate-limit` is registered with `global: true` **inside the v1
plugin**. Because it is fastify-plugin-wrapped it attaches to the scope
it is registered in, so "global" here means the v1 plane and nothing
else. A test hammers the cookie plane to keep that true.

The obvious-looking alternative — `global: false` plus an `onRoute` hook
stamping a default `config.rateLimit` on every v1 route — was tried and
**silently did nothing**. The plugin decides per route inside its own
`onRoute` hook and wins that ordering regardless of when ours is added,
so every route came out unlimited with no error to notice. Recorded here
because the failure mode is invisible.

### A v1-scoped error handler

The plane keeps the house `{ error, message }` envelope, but through its
own handler. The global one masks anything it cannot read a
`statusCode` from as a 500 — which is exactly what happened to the first
rate-limit implementation: every 429 surfaced as
`500 internal_error`.

### The description is generated, and being undocumented is a boot failure

OpenAPI 3.1, generated by `@fastify/swagger` from the **same zod schemas the
routes validate and serialize with** — so the description cannot drift from
the behaviour, because they are the same object. `fastify-type-provider-zod`
supplies the compilers; both are scope-encapsulated, so the browser plane keeps
Fastify's default ajv, which it has never used.

- `GET /api/v1/openapi.json` and `/openapi.yaml` — the description.
- `GET /api/v1/reference` — a browsable reference (Scalar), which **serves its
  own bundle from this origin**. That matters on an air-gapped or
  egress-restricted install: a CDN-loading reference would render a blank page
  with no error. A test asserts the absence of `cdn.jsdelivr.net`/`unpkg.com`
  so a future version cannot quietly reintroduce one.
- All three are **unauthenticated**. Requiring a credential to read the document
  that explains how to get one is a bootstrap loop, and an API description is
  not a secret — it describes routes, not data. An operator who disagrees can
  block the three paths at their proxy without affecting the plane.

`@fastify/swagger` is fastify-plugin-wrapped, so it sees every route in the
app — including ~60 schemaless browser-plane routes. The `transform` hides
anything not under `/api/v1/`, and a test asserts none leaked.

**Three layers keep it honest, in increasing strength:**

1. **Boot-time enforcement.** An `onRoute` hook collects any v1 route lacking a
   `summary`, `tags` or `response`; an `onReady` hook throws naming all of them
   and what each is missing. **An undocumented v1 route is a boot failure** — it
   cannot reach CI, let alone production. This is the mechanical form of "fully
   documented"; a lint rule or a review checklist fails open the first time
   someone is in a hurry. The hook must be installed *before* the routes:
   `onRoute` fires at registration, so a hook added afterwards silently passes.
2. **A committed artifact plus a CI drift job.** `docs/openapi.json` is
   regenerated by the `openapi-drift` job, shaped like `db-drift`, and the build
   fails on any diff. The second benefit is arguably the bigger one: **a
   wire-format change appears as a reviewable diff in the PR** instead of
   something a reviewer must infer from route code.
3. **`docs/API.md` prose.** Hand-written, because a generated reference does not
   explain *why* scope is not the ACL. A test asserts that every path in the
   description is named somewhere in the prose, so the failure that actually
   happens — a route ships and nobody writes it up — fails CI.

   Its honest limits, both real: nothing checks that prose about an *existing*
   route is still true, and the check is per path rather than per operation, so
   adding a method to a path already documented slips through. Saying so here
   is better than implying the hand-written half is verified. It is also why
   every route's path is spelled out in full in a heading rather than
   abbreviated to `.../unarchive` — a shorthand the check cannot see is a
   shorthand a reader searching the document cannot find either.

### Describing a stream

`POST /api/v1/ai/assist` writes to `reply.raw`, so no response schema it
declares would ever run. Rather than declare a JSON shape that is enforced
nowhere, the 200 is `produces: ['text/event-stream']` and the event grammar is
prose — on the operation, and at length in `docs/API.md`. What a generated
client gets is honest: a stream it must read as a stream.

**The trap, found by reading the emitted document rather than trusting it:**
Fastify's `produces` is *route-wide*, so declaring `text/event-stream`
relabelled that operation's 401/403/404/429/503 as event streams too. They are
ordinary JSON, and a generated client would have tried to parse an error body
as a stream. An error body is never a stream, so the fix needs no per-route
marker: `transformObject` puts every non-2xx response on an operation that
produces `text/event-stream` back to `application/json`.

This is the second time a generated artifact has been wrong in a way only
inspection caught (the first was the multipart route 500ing the description
route). The lesson is not about SSE: **`openapi.json` is committed and diffed
precisely because a generator's output deserves reading.**

### The `Input` twins, and a prediction that was wrong

`fastify-type-provider-zod` v7 registers two variants of every schema — the
output shape and an `Input` twin — because a zod schema can transform on parse,
so what a client sends and what it comes back as are not necessarily the same
type. This ADR originally called the unreferenced ones "cosmetic noise", counted
four of them, and predicted the problem would resolve itself as request bodies
arrived with the domain routes.

It did not. It got worse in exact proportion to the plane: a request body
`$ref`s the Input and a response `$ref`s the base, so **one of every pair is
always dead**, and at 50 operations that was 61 of 122 components — half the
document. Every one of them is a type a client generator would have emitted and
nobody could reach.

`transformObject` now prunes by **reachability**, not by name: walk `$ref`s from
`paths` to a fixpoint and drop what that never reaches. A name-based filter on
the `Input` suffix would have worked today and been wrong the first time a
schema is legitimately request-only. `v1.openapi.test.ts` asserts the document
carries no unreachable component.

The dump script fetches `/api/v1/openapi.json` over HTTP rather than calling
`app.swagger()`, for a reason worth recording: **the decorator is not on the
root instance.** Swagger is registered inside the encapsulated v1 plugin, so it
decorates that scope only — which is the encapsulation doing exactly its job.
Going over HTTP also means the committed artifact is byte-for-byte what a
caller receives.

### `snake_case` on the wire

Consistent with the rest of this API. `GET /api/v1/me` therefore returns
`is_admin`, where the browser plane's `GET /api/me` returns `isAdmin`.
The browser plane's shape is load-bearing for
`apps/web/src/lib/api.ts` and is deliberately left alone rather than
churned for symmetry.

## Consequences

- Automation is possible for the first time, and every call is
  attributable to an individually revocable credential.
- Two planes to keep in step. The mitigation is that they will share one
  service layer: each domain's logic is extracted and the browser route
  rewritten as a thin caller **in the same change** that adds its v1
  counterpart, so two implementations never coexist.
- The credential and the ACL are the only controls. Recorded above
  rather than left implicit.
- `POST /api/admin/bot-session` is now redundant for anything except
  local debugging. It is left in place for the harness that uses it.

## Alternatives considered

**Accept the session cookie on `/api/v1` as well.** Rejected. Rotation
means a machine client would need to honour `Set-Cookie` on every call,
which is the trap this plane exists to remove; the scope gate has
nothing to read on a cookie; and accepting a browser credential would
require a CSRF story for the plane forever. Tokens only makes CSRF
structurally impossible rather than mitigated.

**A separate hostname for the API.** Rejected. It buys a clean split, at
the cost of a second DNS record, a second certificate, a proxy route and
an app-side host gate — for every operator, forever, whether or not they
ever call the API. Worse, a second hostname is exactly the shape
[`0027`](0027-single-origin-compose-topology.md) exists to avoid: it
splits the cookie's origin from the app's. Revisit only if there is a
reason a consumer cannot reach the app's own origin.

**Version by header rather than path.** Rejected: a path prefix is
greppable in a log line and routable by a proxy without inspecting
headers, and `Accept`-header versioning is the kind of thing that gets
stripped by an intermediary nobody remembered was there.
