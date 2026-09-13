# Aeolus — Collaborative LaTeX/Typst Editor

## Context

Aeolus is a minimalist, self-hostable alternative to Overleaf for
collaborative drafting of **LaTeX and Typst** documents. It is a webapp,
also shipped as an Electron binary for macOS / Windows / Linux.
Authentication is a local email and passphrase the instance checks
itself — there is no identity provider to stand up and no outbound mail
to arrange. Templates are admin-maintained, so a team's documents come
out consistent. A Claude integration (one instance-wide Anthropic API
key, per-user quotas) helps authors draft sections and clean up markup.

Copyright (C) 2026 David Emerson. Licence: **AGPL-3.0-only**.

This file is the authoritative architecture document; it is updated with
every change.

## Locked decisions

| Area | Decision |
| --- | --- |
| Access model | **Local accounts.** Email plus a passphrase stored as an scrypt hash. First launch creates one administrator; every other account is created by an admin, who hands over a generated passphrase the new user must replace at first sign-in. No self-service signup, no directory sync. |
| LaTeX engine | **Tectonic** only. Typst is a second first-class engine. |
| Collaboration | **Yjs CRDT over WebSocket**, persisted to Postgres. |
| Hosting shape | **One `docker compose` stack** — Caddy in front of `api`, `ws` and `worker`, plus Postgres and MinIO with a one-shot `minio-init` that creates the bucket. `docker-compose.yml`, `Caddyfile` and `.env.example` at the repo root are the whole deployment. |
| Backing services | **Postgres 16** and **S3-compatible object storage**. No Redis — sessions, queue and pub-sub are Postgres-backed (pg-boss + LISTEN/NOTIFY). |
| Electron build | **Thin wrapper** around a hosted instance (menus, auto-update). Sign-in is the app's own form, in the same window. |
| v1 features | Live PDF preview, asset uploads, version history, **Claude-assist** (one instance-wide API key, per-user quotas). |
| Fonts | Jost (UI) and JetBrains Mono (editor/monospace). Both SIL OFL 1.1, vendored under `apps/web/public/fonts/`, licences in `third_party/`. |
| Auth | Local email + passphrase, checked by the app. Email = username. |
| Configuration | Environment variables, documented in `.env.example` and README.md § Configuration. The one value with no default is `AEOLUS_COOKIE_SECRET`. |

Deferred for later (not v1): suggestion / track-changes mode, offline
editing, real-time chat, mobile. Inline comments shipped in May 2026
(see ADR 0014).

---

## High-level architecture

```
                        ┌──────────────────────────────┐
  browser ────────────► │  caddy                       │  the only
  :8080, or 80/443      │  /ws* → ws, else → api       │  published port
                        └───────┬──────────────┬───────┘
                                │              │
                                ▼              ▼
                      ┌──────────────┐  ┌────────────────────┐
                      │  ws          │  │  api               │
                      │  y-websocket │  │  Fastify REST      │
                      │              │  │  + SPA + Claude    │
                      └──────┬───────┘  └────────┬───────────┘
                             │                   │
                             │   ┌────────────┐  │
                             │   │  worker    │  │
                             │   │  Tectonic  │  │
                             │   │  + Typst,  │  │
                             │   │  pg-boss   │  │
                             │   └─────┬──────┘  │
                             ▼         ▼         ▼
                    ┌──────────────────────────────────────┐
                    │  postgres 16                         │
                    │  • application schema                │
                    │  • sessions, ws_tickets              │
                    │  • pgboss.*  (job queue)             │
                    │  • LISTEN/NOTIFY aeolus_room_evict   │
                    └──────────────────────────────────────┘
                             │         │         │
                             ▼         ▼         ▼
                    ┌──────────────────────────────────────┐
                    │  minio  (S3 API)                     │
                    │    docs/<yjsDocId>/snap-<seq>.ydoc   │
                    │    checkpoints/<docId>/<id>.ydoc     │
                    │    assets/<docId>/<uuid>.<ext>       │
                    │    compiled/<docId>/<rev>.pdf        │
                    └──────────────────────────────────────┘
```

Caddy is what makes the session cookie work. The browser talks to
exactly one origin: `handle_path /ws*` strips the prefix and proxies to
the ws process, `handle` sends everything else to the api. Split them
across two hostnames and the WebSocket upgrade carries no cookie, so the
editor connects, appears to work, and saves nothing.
`AEOLUS_SITE_ADDRESS` decides what Caddy serves — `:8080` is plain http
for a laptop; put a real hostname there, publish 80 and 443 instead, and
Caddy gets a Let's Encrypt certificate on its own and renews it.

MinIO is not optional. With no bucket configured each process keeps its
own in-memory blob store and cannot see the others': the api writes a
snapshot, prunes the updates it subsumes, and the ws process then reads
a document that has lost everything before that snapshot — documents
come back truncated with nothing in any log. `minio-init` runs
`mc mb --ignore-existing` once and exits; the app itself never creates
buckets, because that needs a credential far broader than reading and
writing objects. Point `AEOLUS_S3_BUCKET` at this bucket or at real S3,
and never at nothing.

Nothing site-specific is baked into an image: the same three images run
on any hostname. See § Deployment.

## Repository layout

```
aeolus/
├── README.md                  # public overview, updated continuously
├── docker-compose.yml         # the whole deployment: caddy, api, ws, worker, postgres, minio, minio-init
├── Caddyfile                  # one origin; /ws* → ws, everything else → api
├── .env.example               # every setting with its reasoning; copy to .env
├── docs/
│   ├── ARCHITECTURE.md        # this document, authoritative copy
│   ├── API.md                 # hand-written /api/v1 reference
│   ├── openapi.json           # committed OpenAPI 3.1 description (openapi-drift CI job)
│   ├── TEST_PLAN.md           # feature ↔ test map
│   ├── SECURITY.md            # threat model, session model, response headers
│   ├── DECISIONS/             # short ADRs (0001-scope.md, …); README.md is the index
│   └── RUNBOOKS/              # operational playbooks; README.md is the index
├── apps/
│   ├── web/                   # React + Vite + CodeMirror 6
│   ├── electron/              # Electron shell, points at a hosted instance
│   ├── api/                   # Fastify REST + SPA host + Claude proxy
│   │   ├── src/middleware/    # reply-errors.ts, rate-limits.ts, upload.ts, require-user.ts, require-admin.ts
│   │   └── src/services/      # the domain layer both planes call, incl. credentials.ts
│   ├── ws/                    # y-websocket server w/ Postgres persistence
│   │   └── src/log.ts         # pino logger — one JSON line per event, same shape as api
│   └── compile-worker/        # pg-boss consumer, Tectonic + Typst binaries
│       └── native/aeolus-sandbox.c   # the Landlock confinement helper (ADR 0022)
├── packages/
│   ├── shared/                # zod schemas, types, API client, UI primitives
│   ├── auth/                  # Postgres session store, ACL engine, passphrase policy + wordlist
│   ├── crdt/                  # Yjs helpers, snapshot encode/decode, BlobStore, sidecar manifests
│   └── db/                    # Drizzle schema + migrations + runner
│       └── src/env.ts         # required/optional env helpers for the three launchers (ADR 0024)
├── scripts/
│   ├── build-brand-assets.mjs # regenerate the icon set from the mark; --check gates it in CI
│   ├── check-contrast.mjs     # every painted fg/bg pair against WCAG AA, in both themes
│   ├── check-no-private-refs.mjs  # refuses to publish leftovers from the fork's origin
│   └── compose-smoke.mjs      # drives a first run through a browser against the compose stack
├── third_party/               # SIL OFL 1.1 texts for Jost and JetBrains Mono
├── Dockerfile.api             # multi-stage: builds the SPA, serves it alongside the api
├── Dockerfile.ws              # multi-stage image (websocket)
├── Dockerfile.worker          # multi-stage: Tectonic + Typst + the Landlock helper
├── tests/
│   ├── integration/           # API + WS + DB tests (vitest + testcontainers)
│   ├── e2e/                   # Playwright, drives a real browser
│   └── electron/              # Electron shell boot + navigation specs, build smoke
├── .github/actions/
│   ├── install-tectonic/      # composite: pinned Tectonic + Typst, sha256-verified, cached
│   └── setup-pnpm/            # composite: corepack → setup-node (pnpm cache) → frozen install
├── .github/dependabot.yml
└── .github/workflows/
    ├── ci.yml                 # lint, format, gates, typecheck, db-drift, openapi-drift, test, e2e
    ├── docker.yml             # builds the images, starts the stack, drives a first run through it
    └── build-electron.yml     # unsigned installers (ADR 0006) on push/PR/tag
```

Single TypeScript monorepo, managed with **pnpm workspaces** + **Turborepo**.
Node 22 LTS everywhere. Strict TS, ESLint, Prettier.

## Authentication & session model

Aeolus authenticates people itself: an email address and a passphrase,
checked against an scrypt hash in `users.passphrase_hash`. There is no
identity provider to configure, no outbound mail to arrange, and no
third party that has to be reachable for anyone to sign in. The
credential columns live on `users` in `packages/db/src/schema.ts`:
`passphrase_hash`, `passphrase_set_at`, `must_set_passphrase`,
`failed_attempts` and `locked_until`.

### The passphrase policy

`packages/auth/src/passphrase.ts` holds the whole policy in one place,
as pure functions with no side effects, so the API, the SPA's error text
and the tests cannot disagree about what is acceptable.

- **Length and word count, and nothing else.** At least 16 characters:
  four or more words, or a single string of 24 or more (a random string
  out of a password manager is fine without being wordy). No character
  classes, no expiry, no hints — the rules NIST SP 800-63B dropped in
  2017 because they push people toward `P@ssw0rd!` and a sticky note.
  The single sentence the UI shows is the exported `PASSPHRASE_RULE`,
  served by `GET /api/auth/policy`, so the screen cannot promise
  something the server does not enforce.
- **What is rejected beyond length**: a denylist of phrases that already
  clear 16 characters (`correcthorsebatterystaple`, `passwordpassword`),
  a repeated unit (`abcabcabcabc`), a run of eight or more characters
  straight off one keyboard row, four words that are all the same word,
  and anything built out of the caller's email local-part, their own
  name, or the string `aeolus`. Every failing reason is returned at
  once, as `problems[]`, and the setup screen lists them all rather than
  making the user resubmit to find the next one.
- **Generation.** `generatePassphrase()` picks six words from the EFF
  short wordlist (`packages/auth/src/wordlist.ts`) — about 62 bits.
  `GET /api/auth/policy` returns one as a suggestion the setup screen
  offers with a "Use this one" button, and the same function mints every
  system-generated credential.

**Storage** is scrypt from `node:crypto`, N=2¹⁵, r=8, p=1, 64-byte
output — roughly 64 MB per hash. Argon2id would be the modern first
choice, but every Node binding for it is a native module, and a native
module is a build that can fail on someone's architecture. The stored
record is `scrypt$N$r$p$salt$hash`, all base64url: the parameters travel
with the hash, so raising them later does not invalidate anyone's
credential. `verifyPassphrase` reads the stored parameters, refuses
absurd ones (N outside 2¹⁰–2²⁰, r > 32, p > 16) rather than letting a
poisoned row allocate a gigabyte, compares with `timingSafeEqual`, and
returns **false rather than throwing** on a malformed record — a corrupt
row must not be a 500 on the login route, and must not be
distinguishable from a wrong passphrase. `needsRehash` reports a hash
made with weaker parameters than the current ones, and `authenticate`
upgrades it in place on the next successful sign-in.

### Authenticating, and what it refuses to leak

`apps/api/src/services/credentials.ts` owns everything that touches
`users.passphrase_hash`; the routes only turn its errors into status
codes.

- **An unknown address costs the same time as a wrong passphrase.**
  `authenticate` verifies the candidate against a fixed `DUMMY_HASH`
  when the email matches no row, then throws the same
  `InvalidCredentialsError` (401). Without that, response time answers
  "does this address have an account here".
- **Ten consecutive failures lock the account for 15 minutes**
  (`MAX_FAILED_ATTEMPTS`, `LOCKOUT_MS`). The counter lives on the user
  row and is reset by any success; a locked account answers 429 with the
  seconds remaining. That is the per-account half of the defence. The
  per-address half is the rate limit on `POST /api/auth/login` — 30 per
  minute, `middleware/rate-limits.ts` — which runs before
  authentication, where no per-user key exists yet, and which is what
  slows a spray across many accounts.
- **A disabled account is checked *after* the passphrase verifies.**
  `AccountDisabledError` (403) is therefore only reachable by someone
  who holds the credential; to anyone else a disabled account is
  indistinguishable from a wrong passphrase.

### The three routes

All in `apps/api/src/routes/auth.ts`.

| Route | Behaviour |
| --- | --- |
| `GET /api/auth/policy` | The rule sentence plus a freshly generated suggestion. Unauthenticated — the setup screen needs it before the caller has a credential of their own. |
| `POST /api/auth/login` | `{ email, passphrase }` → `authenticate`, then a session and the `aeolus_session` cookie. Returns the user and `must_set_passphrase`. Rate-limited; audits `auth.login`. |
| `POST /api/auth/passphrase` | `{ current?, next }` → `setPassphrase`, 204 on success. Rate-limited; audits `auth.passphrase_set`. |

Sign-out is `DELETE /api/me/session` (`routes/me.ts`): it destroys the
session row, clears the cookie, audits `auth.logout`, and answers 204
whether or not there was a session to destroy.

### Changing a passphrase, and the forced-setup gate

`setPassphrase` requires the current passphrase — a stolen session must
not be enough to take an account over — **except** when the user is
still on a system-generated credential, where the sign-in that got them
here just proved it. The new value goes through `checkPassphrase` with
the user's own email and name as context, and is refused if it is the
one already in use.

Every account created by the first-launch bootstrap or the admin API
starts life with a generated credential and `must_set_passphrase = true`.
(`ensureUserByEmail`, used only by the bot-session mint and the test-only
`/dev/users` route, leaves `passphrase_hash` NULL, and such a row cannot
sign in at all.) `apps/api/src/middleware/require-user.ts`
turns that flag into a gate: such a caller gets
`403 passphrase_setup_required` on every route except
`/api/auth/passphrase`, `/api/auth/policy`, `/api/auth/login`, `/api/me`
and `/api/me/session` — the setup endpoint, the rule text it prints, the
identity the screen renders, and the way out. The gate lives inside
`requireUser` rather than in a hook of its own for a concrete reason:
`resolveUser` rotates the session and sets a fresh cookie as a side
effect, so resolving it a second time in one request would issue two
rotations.

In the SPA, `PassphraseGate` in `apps/web/src/App.tsx` redirects a user
in that state to `/passphrase` from wherever they land, so the 403 never
surfaces as a broken page. `/guide` stays reachable — it is the one
place that explains what is being asked of them.

### First launch, and how anyone else gets in

`bootstrapFirstAdmin` runs from `apps/api/src/bin/server.ts` on every
boot and is a no-op unless the `users` table is empty. When it is, it
creates `AEOLUS_BOOTSTRAP_ADMIN_EMAIL` (default `admin@localhost`) as an
admin with a generated passphrase and `must_set_passphrase = true`, and
the launcher writes that passphrase to **stdout, not through the
logger** — it is the one line an operator has to read out of
`docker compose logs`, and it must not be buried inside a JSON envelope
or dropped by a log level. It is shown once and cannot be recovered.
The race between the count and the insert is caught by the unique index
on `email`; the loser returns `created: false`. Every later boot finds
users and does nothing.

After that, accounts are created by an administrator.
`POST /api/admin/users` (`createUser` in `services/users.ts`) inserts the
row with a generated credential and returns the plaintext exactly once,
for the admin to hand over out of band.
`POST /api/admin/users/:id/reset-passphrase` (`resetUserPassphrase`) is
the whole recovery story: a fresh generated credential, returned once,
`must_set_passphrase` set again, and **every session the target holds
deleted in the same transaction** — a reset that left them signed in
would not recover an account somebody else is already inside. There is
no emailed reset link, because a self-hosted install has no mail server
it can rely on.

### Sessions

The session engine predates passphrase auth and was deliberately left
alone by it.

- Opaque 32-byte `base64url` token in a signed, httpOnly,
  `SameSite=Strict`, `Path=/` cookie named `aeolus_session`.
- Server-side state in the `sessions` table, keyed by
  **SHA-256 of the token**, so a database dump cannot be replayed.
- 12 h idle TTL (sliding `last_seen_at`), 30 d absolute (`expires_at`).
  Expiry is lazy, evaluated on read.
- **The token rotates on every authenticated request.** `touch()`
  inserts a new row and rewinds the old one's idle marker so it dies in
  10 seconds. The consequence is that any client which ignores
  `Set-Cookie` gets exactly one request per token — the cookie is not a
  usable machine credential.
- `sessions.disable_rotation` opts a session out of rotation.
  `POST /api/admin/bot-session` mints one for tooling and returns a
  ready-to-paste `cookie_header`.
- `AEOLUS_COOKIE_SECURE=1` marks the cookie `Secure`. It is off by
  default because a `Secure` cookie is never sent over plain http, so an
  instance reached on a LAN address would be unable to sign anybody in
  with no clue as to why. Turn it on the moment there is https.
- `AEOLUS_COOKIE_DOMAIN` sets the cookie's `Domain`. Leave it unset for
  the shipped topology, where one origin fronts both api and ws and a
  host-only cookie reaches both. It is needed only when api and ws are
  split across two hostnames, and getting it wrong is exactly the
  failure where the editor connects and saves nothing.

### Failure mode: closed

`AEOLUS_COOKIE_SECRET` has no default in production: `requireEnv` throws
`MissingEnvError` at boot when `NODE_ENV=production` and it is unset
(ADR 0024), and `docker-compose.yml` refuses to start the stack without
one rather than shipping a value every install would share. api and ws
must be given the same value — the api signs the session cookie with it
and ws verifies that signature on every upgrade, so a mismatch is not a
partial degradation, it is nobody being able to edit.

## Machine API (`/api/v1`)

Decisions: [`0019`](DECISIONS/0019-machine-api-plane.md) (the plane),
[`0020`](DECISIONS/0020-self-service-api-tokens.md) (the credential).

A versioned REST plane in the same api process, on the same host,
registered as a **sibling** of the `/api` block rather than nested
inside it — the v1 plugin installs an `onRequest` auth hook, its own
`setNotFoundHandler`, its own `setErrorHandler` and a rate limiter, and
Fastify encapsulation is what keeps all four off the browser plane. (The
browser plane has its own, opt-in limiter since ADR 0025 — four routes
name a budget in `middleware/rate-limits.ts`; both handlers share
`middleware/reply-errors.ts`'s `publicError()` for the envelope.)

- **Credential**: `Authorization: Bearer aeolus_<16 hex>_<secret>`.
  Rows in `api_tokens`, hash-at-rest, minted by users at `/tokens`.
  Cookies are **not** accepted here.
- **A token acts as its minting user**, so `resolveRole`,
  `assertCanRead` and `assertCanWrite` are reused unchanged and the
  document ACL applies exactly as it does in the browser. Scope and ACL
  are separate gates and both apply.
- **The gate covers the prefix**, not just registered routes: the plugin
  owns its own not-found handler, so an unmatched `/api/v1/...` answers
  401 before it answers 404 rather than telling an anonymous caller
  which routes exist.
- **Rate limit**: 120 req/min per credential, keyed on `sha256(bearer)`,
  registered `global: true` *inside* the v1 plugin so it covers this
  plane and nothing else. Keying on the credential rather than the
  address is what makes it work behind a reverse proxy: every request
  arrives from Caddy, so a rule in front keyed on the peer address would
  meter every caller in the world as a single source.
- **Wire format** is `snake_case`, unlike the browser plane's
  `GET /api/me`, which returns `isAdmin`/`mustSetPassphrase` and is left
  alone because `apps/web/src/lib/api.ts` depends on its shape.
- **Coverage** is the whole domain the UI covers, in 50 operations:
  identity, documents, files and content, templates, compile, version
  history, administration, Claude-assist and the collaboration ticket.
  Deliberately absent: **token management itself** — a write token able
  to mint tokens could outlive its own revocation.

### The service layer

Both planes call one implementation. `apps/api/src/services/*` holds the
domain logic; the routes on either side parse a request, call a service,
and choose a success status. Decision and the review rule that keeps it
honest: [`0021`](DECISIONS/0021-service-layer-extraction.md).

- Signature `service(ctx, actor, input)`. **No Fastify types below that
  line** — no `reply`, no status codes, no serialisation.
- Errors are **thrown**, not mapped. The ACL errors already carry
  `statusCode`/`code`, and both planes' error handlers read them.
- `ctx.audit` is pre-bound with the request's IP, user-agent and actor, and
  stamps `via: api_token` automatically for a token-driven change — so one
  audit query answers "what did automation do" without a second vocabulary.

Extraction happens **one domain at a time, with the browser route rewritten
in the same change**, so two implementations never coexist. It is now
complete for every domain `/api/v1` serves: documents, files (which finally
collapsed `/assets` onto the same implementation — issue #9 phase 4),
templates, compile (+ zip), checkpoints (+ project checkpoints), users and
audit events. Roughly 3,600 lines of inline route logic became ~1,100 lines
of routes over a service layer both planes call.

Claude-assist and the collaboration ticket followed, which finished the job:
every route file that both planes serve now sits over one service. Assist is
the only one that could not simply return a value — it streams — so its
service takes a **sink**, and the rule survives intact: everything that can
still be an HTTP status is thrown before the sink opens, and nothing below the
service line knows what a `reply` is.

Two things the file extraction folded in, because an extraction is the
cheapest moment to do them: `services/file-paths.ts` now holds the MIME
allowlist, size caps and path validator that `files.ts` and `assets.ts` each
carried a copy of; and `services/room-evict.ts` holds the `pg_notify`
block that `checkpoints.ts` and `project-checkpoints.ts` each carried a copy
of.

Enforced 2026-09-13 (polish pass, part 9): the last writes that lived in
route handlers moved down — the bot-session and `/dev/users` upserts are
`ensureUserByEmail` in `services/users.ts`, and the credential writes are
`services/credentials.ts`; the diagnostics smoke compile creates, enqueues and
soft-deletes through `createDoc`, `enqueueCompile` and `deleteDoc`; the
logout and token audit rows go through `ServiceContext.audit`, which
stamps IP, user-agent and actor. No route module inserts or updates a
table directly, and `apps/ws` reads `is_admin` through the shared drizzle
schema rather than raw SQL.

`tests/integration/route-acl.test.ts` carries a parallel block that asks
both planes the same ACL questions and compares the answers, so a
divergence fails one file with both statuses visible.

### Reading and writing text over HTTP

`GET`/`PUT /api/v1/docs/:id/files/:fileId/content` are the first way to
reach document text outside the editor's WebSocket.

A write is applied as a **single Yjs transaction against the live
document** — the same mechanic as a checkpoint restore — and then
`pg_notify`s the ws process to evict its in-memory room. Writing a column
instead would desynchronise anyone with the file open: their next
keystroke would reintroduce the old text.

`rev` is the CRDT sequence the content was read at. Passing it back as
`if_rev` makes the write conditional (`412 revision_mismatch`, whose body
carries the current revision so a client can re-read without guessing).
Omitting it is last-writer-wins.

### The description

OpenAPI 3.1 at `/api/v1/openapi.json` (and `.yaml`), with a browsable
reference at `/api/v1/reference`. All three are unauthenticated —
requiring a credential to read the document that explains how to obtain
one is a bootstrap loop.

Generated by `@fastify/swagger` from the **same zod schemas the routes
validate and serialize with** (`fastify-type-provider-zod`), so the
description cannot drift from the behaviour. `@fastify/swagger` is
fastify-plugin-wrapped and sees every route in the app, so the
`transform` hides anything not under `/api/v1/`.

Three layers keep it honest:

1. **Boot-time.** A v1 route lacking `summary`, `tags` or `response`
   throws at `onReady`. An undocumented route cannot start the app, let
   alone reach production. The hook is installed *before* the routes —
   `onRoute` fires at registration, so one added afterwards sees nothing
   and passes silently.
2. **`docs/openapi.json`** is committed and the `openapi-drift` CI job
   fails on any diff. Second benefit: a wire-format change shows up as a
   reviewable diff on the PR.
3. **`docs/API.md`** is hand-written prose, for the things a generated
   reference cannot say — notably that scope is not the ACL.

The Scalar reference **serves its own bundle from this origin**. That is
load-bearing on an instance with no outbound internet — a CDN-loading
reference would be a blank page with no error. A test asserts no
`cdn.jsdelivr.net` or `unpkg.com` appears.

Note `apps/api/scripts/dump-openapi.mjs` fetches the endpoint over HTTP
rather than calling `app.swagger()`: the decorator is not on the root
instance, because swagger is registered inside the encapsulated v1
plugin. That is the encapsulation working, not a bug.

Token management (`GET`/`POST /api/tokens`, `DELETE /api/tokens/:id`)
lives on the **browser** plane, session-gated: a token that could mint a
token would outlive its own revocation.

### Proxy and logging posture, and the framing headers

Two `Fastify()` options that are easy to miss and both matter behind a
reverse proxy:

- **`trustProxy` is off by default**, and set by `AEOLUS_TRUST_PROXY`
  (`parseTrustProxy` in `apps/api/src/bin/server.ts`). Off means
  `request.ip` is the socket peer, which behind a proxy is the proxy for
  every caller. `true` means the whole of `x-forwarded-for` is believed
  — and the caller writes that header, so the sign-in rate limiter,
  which keys on `request.ip`, would be metering a fiction. The safe
  answer is to name the proxy: a list of addresses or CIDR blocks, or
  one of `loopback`, `linklocal`, `uniquelocal`. `docker-compose.yml`
  sets `uniquelocal`, which covers Caddy on the private Docker network.
  A bare hop count is deliberately not supported — Fastify's numeric
  form cannot validate the peer, so it trusts nothing and looks like a
  silent misconfiguration.
- **`logger` defaults on in production.** It previously defaulted to
  `false` with `AEOLUS_LOG=1` as the only way to enable it, and the
  launcher passed `AEOLUS_LOG === '1'` — a boolean whatever the value,
  which defeated that default. The consequence was that the global
  `setErrorHandler`'s `request.log.error({ err }, 'request failed')` on
  every 5xx wrote to nothing. `envFlagOrUndefined` now leaves it
  `undefined` when the variable is unset, so the default applies.
  `disableRequestLogging: true` remains set, so this does not add a
  per-request access line; what it turns on is exactly the errors that
  were being discarded. Request ids are an inbound `x-request-id` when
  present and a `randomUUID()` otherwise — Fastify's default is a
  per-process counter that restarts at `req-1` on every restart.

**Framing.** A global `onSend` hook in `apps/api/src/server.ts` puts a
set-if-absent `content-security-policy: frame-ancestors …` on every
response — API routes, SPA assets, the `index.html` fallback, 404s. It
is never `X-Frame-Options`: that header has no cross-origin allow-list,
so a stray `SAMEORIGIN` would override whatever was configured. The
default is `'self'` — nothing may frame Aeolus but Aeolus.
`AEOLUS_FRAME_ANCESTORS` widens it, as CSP source expressions separated
by spaces or commas; every origin listed there can put the editor in an
iframe on a page you do not control, so list only sites you run.

Since 2026-09-13 (ADR 0025) responses also carry helmet's headers — with
`Cross-Origin-Opener-Policy: same-origin-allow-popups`, because the PDF
preview opens in a new tab and reaches back through `window.opener`, and
HSTS only when `AEOLUS_COOKIE_SECURE` says there is https — plus a
`content-security-policy-report-only` carrying the full candidate policy
with `report-uri /api/csp-report`. Violations are logged at warn with
the directive and the blocked URI, truncated, and nothing else: the body
is untrusted input. `connect-src` in that candidate policy includes the
ws origin when `AEOLUS_WS_URL` names one. See `docs/SECURITY.md`
§ Response headers and the CSP.

### WebSocket authentication

The Yjs socket does not use the session cookie directly. `POST
/api/ws/ticket` issues a 32-byte ticket, SHA-256-hashed into
`ws_tickets`, bound to one `doc_id`, valid 5 minutes and **multi-use
within that window**. `apps/ws` consumes it on upgrade, falling back to
the cookie. The multi-use property matters: y-websocket rebuilds its
URL from `provider.params` on every re-dial, so a one-shot ticket turns
an ordinary reconnect into a `1008 invalid_ticket` failure.

## Document model & ACL

Phase 05 (`apps/api/src/routes/docs.ts`) exposes the REST surface for
documents and the access-control rules every later phase (Yjs,
compile, history) relies on. Every route is protected by the session
middleware — an unauthenticated call returns 401.

- **Roles** (`apps/api/src/acl.ts`):
  - `owner` — the `docs.owner_id` row. Admins always resolve to
    `owner` regardless of the row (so they can open and mutate any
    document, including soft-deleted ones).
  - `editor` — entry in `doc_collaborators` with `role='editor'`.
    Can read and write content (title, body), but cannot delete or
    manage collaborators.
  - `viewer` — entry in `doc_collaborators` with `role='viewer'`.
    Read-only.
  - `none` — no access. The helper also returns `none` for
    soft-deleted docs when the caller is not an admin, and for any
    malformed doc id (the UUID shape is checked before touching the
    database).
- **Helper surface** — every route uses one of:
  - `resolveRole(deps, userId, docId)` → `DocRole | 'none'`
  - `assertCanRead(deps, userId, docId)` → throws `DocNotFoundError`
    (404) unless the role is owner/editor/viewer.
  - `assertCanWrite(deps, userId, docId)` → throws
    `DocNotFoundError` for non-members (so existence is never
    leaked), and `DocForbiddenError` (403) for viewers who already
    know the doc exists.
  - `createDbAclDeps(db)` — adapts a Drizzle `Database` to the
    `AclDeps` interface used by the helpers. The same interface is
    satisfied structurally by `@aeolus/shared`'s `TestDb`, which is
    how `apps/api/src/acl.test.ts` unit-tests the helper without a
    real Postgres.
- **Existence leakage policy**: unauthorized reads return 404 (not
  403). See `docs/DECISIONS/0003-acl-404-vs-403.md`.
- **Endpoints**:
  - `POST /docs` — body `{title, engine}`. **Admin-only** (issue
    #39); end users go through `POST /templates/:id/fork`. Creates
    a doc owned by the caller. Engine is fixed at creation;
    changing engine requires forking (phase 08). Because it is
    fixed, the workspace's "New document" control carries an
    engine picker (`new-doc-engine`, LaTeX default) — it previously
    hardcoded `latex`, which combined with the immutability made a
    blank Typst document impossible to create without an admin
    first authoring a Typst template to fork.
  - `GET /docs` — lists docs the caller owns or collaborates on
    (non-deleted, non-archived by default). `?status=active|
    archived|all` filters by the new archive flag (issue, ADR-
    style: doc-level archive lock). Admins see all non-deleted
    docs, and can pass `?includeDeleted=true` to include soft-
    deleted rows. The flag is silently ignored for non-admins.
  - `GET /docs/:id` — returns doc metadata if the caller can read it.
  - `PATCH /docs/:id` — updates `title` only. Owner, editor
    collaborator, or admin. Engine is immutable. Archived docs
    return 422 `archived` (the lock applies to all writers).
  - `DELETE /docs/:id` — soft-delete (sets `deleted_at`). Owner or
    admin only. Editors and viewers get 403.
  - `POST /docs/:id/archive` — owner or admin marks the doc
    read-only by setting `archived_at`. Idempotent.
  - `POST /docs/:id/unarchive` — owner or admin clears
    `archived_at`. Idempotent.
  - `POST /docs/:id/collaborators` — body `{email, role}`. Owner or
    admin only. Looks up the user by email; if the address matches
    no user, returns 409 `user_not_found` — an administrator creates
    the account first. A duplicate collaborator returns 409
    `already_collaborator`.
  - `DELETE /docs/:id/collaborators/:userId` — owner or admin only.
- **Admin override**: because `resolveRole` returns `owner` for any
  admin, admins transparently pass every ACL gate in this module —
  no separate branching in route handlers. The one exception is the
  archive lock: `assertCanWrite` throws `DocArchivedError` for
  archived docs even when the caller is an admin. Admins unarchive
  first, do their edits, archive again. The archive/unarchive
  routes themselves go through `resolveRole` (not `assertCanWrite`)
  so the lock can't block its own toggle.

## Collaboration & persistence

> **Per-file Yjs (ADR 0013).** The unit of Yjs persistence is the
> *text file*, not the document. Every `kind='text'` row in
> `doc_files` has its own `yjs_doc_id`, and `doc_updates`,
> `doc_snapshots` and `doc_checkpoints` each carry a foreign key to
> that column. Postgres will not accept a foreign key to a column
> that is not unique, so the schema declares
> `unique('doc_files_yjs_doc_id_unique')` on it. Rooms, ACL helpers,
> compile-event fan-out, and the descriptions below are all keyed
> on `yjs_doc_id`; the legacy `docId` parameter names below survive
> for narrative continuity. The compile worker walks every
> `kind='text'` row and writes its rendered source into the
> workdir alongside the entrypoint, so `\input{frontmatter}`
> resolves when `frontmatter.tex` is a sibling text file (issues
> #36 / #44). `kind='folder'` rows carry a path with no
> `yjs_doc_id` and no `storage_key` — they exist so
> explicitly-created empty folders survive a reload.

- **Editor CRDT**: Yjs. Each document has one `Y.Doc` with a `Y.Text`
  holding source, plus a `Y.Map` for metadata (engine, asset list).
- **Transport**: plain `ws` (`noServer: true`) in `apps/ws`, reusing
  Node's `http.Server` for upgrades. The server speaks the standard
  `y-protocols/sync` + `y-protocols/awareness` framing, demuxed in
  `apps/ws/src/protocol.ts`. Each `docId` gets a shared in-memory
  room (`apps/ws/src/room.ts`) holding the `Y.Doc`, `Awareness`,
  connection set, and an awaiting `persistChain` so update writes
  are serialised per room.
- **Persistence strategy** (`packages/crdt/src/persist.ts`):
  - `persistUpdate(deps, docId, seq, bytes, authorId)` appends every
    inbound update to `doc_updates(doc_id, seq, update bytea,
    author_id)`; `seq` is allocated by the room so writes within a
    room are monotonic even under concurrent clients.
  - `snapshotDoc(deps, docId, doc, upToSeq)` writes the full
    `Y.encodeStateAsUpdate` to the blob store under
    `docs/<id>/snap-<seq>.ydoc`, upserts the pointer row in
    `doc_snapshots` (one row per doc), and deletes every
    `doc_updates` row with `seq <= upToSeq`. Triggered every 200
    updates or after 5 min of idle, and exposed as
    `WsServerHandle.forceSnapshot(docId)` for tests.
  - `loadDoc(deps, docId)` hydrates from the latest blob snapshot
    (if any) and replays all `doc_updates` with `seq > snapshot_seq`
    in order — this is what runs on room open and on `ws` cold
    start.
  - The blob abstraction (`packages/crdt/src/blob.ts`) provides
    `BlobStore` with `MemoryBlobStore` for tests and an `S3BlobStore`
    wrapping `@aws-sdk/client-s3` for anything that speaks the S3 API —
    the bundled MinIO, or S3 itself. `blobStoreFromEnv()` picks between
    them and refuses the in-memory one in production.
- **Presence**: `y-protocols/awareness` for cursors + names. The
  client sets `user = {name, color, colorLight}` on its awareness
  state when the provider connects (#68) — `name` from the session
  (`/api/me` display name, else the mailbox half of the email),
  `color` from an FNV-1a hash of the user id into an eight-hue
  palette with one variant per editor ground
  (`apps/web/src/lib/collab-colors.ts`; light on Solarized base3,
  dark on base03; every pair ≥ ΔE76 22.8, carets ≥ 3.95:1 against
  the ground, label text ≥ 4.26:1 — checked by
  `collab-colors.test.ts`), re-published when the theme flips.
  y-codemirror.next renders those as the remote caret, its label
  and the selection tint; without the field it falls back to one
  cyan "Anonymous" for everyone, which is what Aeolus showed until
  2026-09. The caret label is restyled in `editor-theme.ts` (brand
  mono; label text flips to base03 on the dark ground where white
  would be ~2:1). No
  backend storage; each connection tracks its awareness client ids
  and the room cleans them up on socket close/error. Awareness
  updates are relayed to **every** connection in the room,
  including the sender — the echo doubles as the keepalive for solo
  editors: y-websocket's client closes any socket silent for 30s
  (`messageReconnectTimeout`), and the client renews its awareness
  every ~15s, so without the echo a solo tab churns through a
  reconnect every ~30 seconds.
- **ACL check**: the upgrade handler (`apps/ws/src/server.ts`)
  authenticates the preferred path first — a `?ticket=` bearer
  minted by `POST /api/ws/ticket` (cookie-gated on the api origin,
  bound to a docId, multi-use within a 5-minute TTL, validated
  against the `ws_tickets` table; the SPA re-mints via
  `apps/web/src/lib/ws-ticket.ts` so reconnects never present an
  expired one). Without a ticket it falls back to unsigning the
  `aeolus_session` cookie with the same `@fastify/cookie` signer used
  by `apps/api`, loading the session from Postgres via
  `createSessionStore` (shared from `@aeolus/auth`), then running
  `assertCanRead(aclDeps, userId, docId)`. Any failure closes the
  socket with code **1008** (policy violation) and emits a
  structured `[ws] upgrade_rejected reason=…` log line; internal
  errors close with **1011**. The authoritative cookie name,
  session store, and ACL helpers live in `packages/auth` so the
  `ws` server reuses them with zero duplication.
- **Connect window**: the 101 is sent before authentication, so
  the client's first frames (y-websocket sends sync step 1 on
  `open`) arrive while the server is still authenticating and then
  loading the room (a `doc_snapshots` read, the snapshot S3 GET,
  the `doc_updates` replay). Those frames are buffered by an
  early-message listener that stays attached until the room is
  ready; the real handler is swapped in synchronously and the
  buffer replayed after the server's own step 1. Until 2026-09-13
  the buffer was detached before the room load, so a step 1 landing
  in that window was dropped and the client showed an empty document
  until its next reconnect (`tests/integration/yjs.converge.test.ts`
  "a frame that arrives while the room is still loading").
- **Room eviction.** `apps/ws` keeps one dedicated `pg.PoolClient`
  in `LISTEN` mode on `aeolus_room_evict` (`ROOM_EVICT_CHANNEL`) and
  drops the named room's in-memory `Y.Doc` when it fires. The notify
  side is `apps/api/src/services/room-evict.ts`, called after a write
  that replaced a file's contents behind the editor's back — a
  checkpoint restore, or a `PUT …/content` on the machine plane.
  Without it, the next keystroke from anyone with the file open would
  reintroduce the old text. This is the only Postgres notification
  channel left; the compile-event one was removed (see § Process boot).
  `/readyz` on ws checks that this client is alive.
- **`/diagnostics`** (admin-only, cookie-gated; consumed by
  `GET /api/admin/diagnostics`): exact-path match, admin flag read
  through the shared drizzle schema, and a 500 carries only
  `{ error: 'internal' }` — the underlying message goes to the ws
  log, since the handler is reachable before authentication.
- **Version history (v1)** — implemented in
  `apps/api/src/routes/checkpoints.ts` and
  `apps/web/src/components/HistoryPanel.tsx`:
  - User-named checkpoints stored as full Yjs snapshots in S3 under
    `checkpoints/<docId>/<checkpointId>.ydoc`, with metadata in
    `doc_checkpoints` (id, doc_id, label, snapshot_key, created_by,
    created_at). Labels are capped at 120 characters and HTML-escaped
    on display.
  - **Endpoints**:
    - `POST /docs/:id/checkpoints` — body `{label}`. Encodes the
      current Y.Doc state, uploads to S3, inserts a
      `doc_checkpoints` row. Requires write access.
    - `GET /docs/:id/checkpoints` — lists all checkpoints for the
      doc, newest first. Requires read access.
    - `GET /docs/:id/checkpoints/:checkpointId` — returns metadata
      and a `download_url` the client uses to fetch the raw Yjs
      snapshot bytes for time-travel preview.
    - `GET /docs/:id/checkpoints/:checkpointId/download` — serves
      the raw Yjs snapshot as `application/octet-stream`.
    - `POST /docs/:id/checkpoints/:checkpointId/restore` — loads the
      snapshot, computes the Yjs diff against the live doc, applies
      it as a single authored update via `persistUpdate`. Restore is
      never destructive — it creates a new update, preserving the
      full history.
  - **Auto-open snapshots** (`doc_checkpoints.kind = 'auto_open'`).
    The SPA fires `POST /docs/:id/checkpoints?fileId=...` with
    `{ auto: true }` whenever the editor mounts a file. Server
    fabricates a label of `Opened by <email>` and applies
    per-user-per-file 5-minute coalescing (returns
    `{ skipped: true, reason: 'coalesced' }` on hit). Archived docs
    reject with 422 `archived`; viewers reject with 403; the web
    client swallows both. Auto rows
    expire after 30 days via a best-effort sweep run as a side
    effect of every list call (same pattern as `audit_events`
    per ADR 0015) — the sweep deletes the DB row and the S3 blob
    in pairs and swallows per-object errors so a partial S3
    outage doesn't break the list response. User-named
    checkpoints are not affected by this sweep. The list
    response carries `kind`, `created_by`, and `created_by_email`
    (joined from `users`) so the panel can show "Opened by
    alice@…" without a second round-trip.
  - **Editor undo/redo** is wired to the Yjs UndoManager via
    `yUndoManagerKeymap` from `y-codemirror.next` (which
    `yCollab(...)` instantiates by default). CodeMirror's local
    `history()` and `historyKeymap` are intentionally NOT
    included — Cmd+Z under the local-history setup produced a
    fresh Y.Text edit instead of reversing the prior Yjs
    operation, so the visible "undo" was actually a forward edit
    that the Yjs UndoManager couldn't reverse.
  - **Web UI**: sidebar "History" tab (toggled alongside the
    "Assets" tab) with a button to create a checkpoint and a
    scrollable list of prior checkpoints. Clicking a checkpoint
    opens a read-only preview in the right pane (replacing the PDF
    preview). A "Restore" button with a confirmation modal applies
    the checkpoint back onto the live doc. Auto-open rows render
    in italic `ink-500` and can be hidden via a "Show auto"
    toggle once the trail gets long.

## Database

- **Engine**: Postgres 16. The compose stack runs the
  `postgres:16-alpine` image on the private network with no published
  port; integration tests spin up their own container via
  `@testcontainers/postgresql`. Pointing `DATABASE_URL` at a managed
  Postgres works — see `AEOLUS_DB_SSL` below.
- **ORM**: Drizzle ORM (`drizzle-orm`, `drizzle-kit`) in
  `packages/db`. The schema is authored in `packages/db/src/schema.ts`;
  migrations are generated from it, never hand-written. Edit the schema,
  run `pnpm --filter @aeolus/db exec drizzle-kit generate`, and commit
  the generated SQL under `packages/db/migrations/` together with the
  updated `packages/db/migrations/meta/` snapshot. The `db-drift` CI job
  re-runs the generator and fails on any diff, so a schema change
  without its migration does not reach main. Apply migrations with
  `pnpm --filter @aeolus/db migrate` (`DATABASE_URL` required); the
  services also run them at boot.
- **UUIDs**: all primary keys default to `gen_random_uuid()`,
  which has been built into Postgres since v13 — we don't load
  the `pgcrypto` extension. (drizzle-kit emits
  `CREATE EXTENSION IF NOT EXISTS pgcrypto;` defensively in
  generated migrations; we strip it, so the runtime database role
  never needs the privilege to install extensions. See ADR 0010.)
- **Timestamps**: `timestamptz`, default `now()`, `NOT NULL`. Mutable
  rows carry both `created_at` and `updated_at`; write-once rows
  (`audit_events`, `api_tokens`, `ws_tickets`,
  `doc_project_checkpoint_blobs`) carry only the one they need.
  `updated_at` is kept current in the application layer, bumped on every
  mutation — there is no trigger.
- **Descending indexes are spelled `.desc().nullsFirst()`.** Drizzle's
  bare `.desc()` emits `DESC NULLS LAST`, and Postgres will not use such
  an index to answer `ORDER BY x DESC` — which means `NULLS FIRST` — so
  the newest-first list query the index exists for falls back to a
  sequential scan and a sort. Every descending index in
  `packages/db/src/schema.ts` carries `.nullsFirst()`, and the next one
  has to as well.
- **The core tables** — `packages/db/src/schema.ts` is the authority and
  `packages/db/migrations/0000_initial.sql` is the SQL Postgres runs:

| Table | Columns | Purpose |
| --- | --- | --- |
| `users` | `id`, `email` (unique), `name`, `is_admin`, `anthropic_consent_at`, `disabled_at`, `created_at`, `updated_at` | Accounts. The first is created at first launch when the table is empty; every other one by an admin. `disabled_at` is a soft-disable: `resolveUser` treats the account as unauthenticated from the moment it is set, killing every live session without deleting anything. |
| `users` credential columns | `passphrase_hash`, `passphrase_set_at`, `must_set_passphrase`, `failed_attempts`, `locked_until` | Local passphrase authentication. `passphrase_hash` is `scrypt$N$r$p$salt$hash`; it is NULL only for a row an admin created without issuing a credential, and such a user cannot sign in. |
| `sessions` | `id`, `user_id → users` (cascade), `token_hash` (unique), `expires_at`, `last_seen_at`, `user_agent`, `disable_rotation`, `created_at`, `updated_at` | Server-side session state mirror. |
| `templates` | `id`, `name`, `description`, `engine` (check in `latex`/`typst`), `thumbnail_key`, `is_published`, `yjs_doc_id → docs` (cascade, unique), `created_by → users` (set null), `deleted_at`, `created_at`, `updated_at` | Document templates. The `yjs_doc_id` points at the template's backing document (a `docs` row with `is_template_doc = true`). |
| `docs` | `id`, `title`, `engine` (check in `latex`/`typst`), `owner_id → users` (RESTRICT), `forked_from_template → templates` (set null), `is_template_doc` (bool, default `false`), `deleted_at`, `archived_at`, `created_at`, `updated_at` | Top-level document rows. `is_template_doc = true` rows are the backing storage for templates and never appear in user-facing doc lists. `archived_at` is a doc-level read-only lock — independent of `deleted_at` and `is_template_doc`; when set, `assertCanWrite` throws `DocArchivedError` (422 `archived`) for owners and editors alike, and a partial index covers the archived-only filter. `owner_id` is RESTRICT so deleting a user cannot wipe their docs — the admin DELETE handler transfers ownership to the deleting admin in the same transaction. |
| `doc_collaborators` | `id`, `doc_id → docs` (cascade), `user_id → users` (cascade), `role` (check in `viewer`/`editor`), unique `(doc_id, user_id)`, `created_at`, `updated_at` | Per-doc ACL entries. |
| `doc_files` | `id`, `doc_id → docs` (cascade), `path`, `kind` (check in `text`/`blob`/`folder`), `yjs_doc_id` (unique), `storage_key`, `filename`, `mime_type`, `size_bytes int`, `uploaded_by → users` (set null), unique `(doc_id, path)`, `created_at`, `updated_at` | One row per file in a project. A check constraint enforces the three shapes: `text` rows carry a `yjs_doc_id` and no `storage_key`, `blob` rows the reverse, `folder` rows neither. `(doc_id, path)` UNIQUE stops a folder and a file colliding on one path. `yjs_doc_id` is UNIQUE because three tables take a foreign key to it. |
| `doc_updates` | `id`, `yjs_doc_id → doc_files.yjs_doc_id` (cascade), `seq bigint`, `update bytea`, `author_id → users` (set null), unique `(yjs_doc_id, seq)`, `created_at`, `updated_at` | Append-only Yjs update log, one stream per text file. |
| `doc_snapshots` | `id`, `yjs_doc_id → doc_files.yjs_doc_id` (cascade, unique), `snapshot_seq bigint`, `snapshot_key`, `bytes bigint`, `created_at`, `updated_at` | Latest compaction snapshot pointer, one row per text file. `bytes` is the encoded byte count written by `snapshotDoc`, which lets `GET /api/docs/:id/files` report a size for text files (`bytes` + Σ`octet_length(update)`) without an S3 HEAD per row. |
| `doc_checkpoints` | `id`, `yjs_doc_id → doc_files.yjs_doc_id` (cascade), `label`, `snapshot_key`, `created_by → users` (set null), `project_checkpoint_id → doc_project_checkpoints` (cascade), `kind` (check in `user`/`auto_open`, default `user`), `created_at`, `updated_at` | Full Yjs snapshots in object storage. `kind` separates user-named checkpoints from the auto-open trail the SPA fires whenever the editor mounts a file; auto rows expire after 30 days via a sweep run as a side effect of every list call. A `(kind, created_at)` index backs that sweep. |
| `compile_results` | `id`, `doc_id → docs` (cascade), `job_id` (unique), `engine` (check in `latex`/`typst`), `rev bigint`, `status` (check in `queued`/`running`/`success`/`failed`), `pdf_key`, `synctex_key`, `error`, `warnings jsonb`, `started_at`, `finished_at`, `created_at`, `updated_at` | One row per compile. `synctex_key` is the object key of the parsed synctex JSON map — null for typst and for parse failures. `warnings` is the author-facing list recorded on a successful compile (fonts the PDF references but does not embed, #80) — null on failures, rendered as `[]` by the API. Indexed on `(status, created_at)`, `(doc_id)`, and `(doc_id, created_at DESC NULLS FIRST)` — the last backs `GET /docs/:id/synctex/latest`, whose newest-row-per-doc lookup the status-leading index cannot serve. |
| `ai_requests` | `id`, `user_id → users` (cascade), `doc_id → docs` (cascade), `input_tokens`, `output_tokens`, `cached_input_tokens` (default 0), `cost_usd_cents`, `instruction`, `status`, `created_at`, `updated_at` | Claude-assist call ledger. |
| `ai_quota` | `id`, `user_id → users` (cascade, unique), `per_hour` (default 30), `per_day` (default 200), `tokens_per_day` (default 50000), `created_at`, `updated_at` | Per-user quota overrides. |
| `audit_events` | `id`, `occurred_at`, `actor_id → users` (set null), `actor_email`, `action`, `resource_type`, `resource_id`, `metadata jsonb`, `ip`, `user_agent`, three indexes covering the list endpoint's access patterns | Authentication + major-mutation audit log. 30-day retention enforced as a side effect of each list call. See ADR 0015. |

- **Foreign-key semantics**: cascades are used wherever a child row
  cannot meaningfully outlive its parent (sessions, doc content).
  `set null` is used for audit fields (`doc_updates.author_id`,
  `doc_checkpoints.created_by`, `templates.created_by`) so that
  deleting an admin does not wipe history. The one deliberate
  exception is `docs.owner_id`, which is RESTRICT so a user delete
  cannot silently take their documents with it.
- **Schema tests**: `tests/integration/db.schema.test.ts` boots a
  real Postgres 16 container via `@testcontainers/postgresql`, runs
  the migrations through `runMigrations()` (the custom replay
  helper from ADR 0010, not drizzle's), and asserts each table
  and every required column exists with the expected data type
  and nullability by querying `information_schema.columns`.
- **Migration runner**: ADR 0010. We replaced
  `drizzle-orm/migrate` with a small custom runner because the
  default opens with `CREATE SCHEMA "drizzle"`, and Postgres
  requires CREATE-on-database for that — a privilege the runtime
  role should not need. The runner keeps drizzle's
  on-disk format and SHA-256 hashing, just puts its bookkeeping
  in `public.__drizzle_migrations` and replays through a
  `pg_advisory_lock`-wrapped transaction.
- **TLS**: `AEOLUS_DB_SSL` decides it outright, and nothing else is
  consulted when it is set. `poolSslFor()` in `packages/db/src/index.ts`
  reads it:
  - `disable` — no TLS. What the compose stack uses: Postgres is on a
    private Docker network with no published port.
  - `require` — TLS with the certificate unverified. Encrypted against a
    passive listener, useless against an active one.
  - `verify` — TLS with the chain verified against a PEM bundle read
    from `AEOLUS_DB_CA_FILE` (default
    `/etc/ssl/certs/aeolus-db-ca.pem`). The right answer for a managed
    database reached across a network. Set to `verify` with no bundle
    present, the process refuses to boot and the error names the path it
    looked at.

  No CA bundle is baked into any image — a vendored one would be a
  provider-specific root nobody else needs. Mount your provider's bundle
  and point `AEOLUS_DB_CA_FILE` at it.

  Unset, `poolSslFor` falls back to a guess from the hostname: no TLS for
  `localhost`, `127.0.0.1`, `::1`, `postgres:` or `db:`; TLS otherwise,
  verified when a bundle happens to be present. The fallback exists
  because a managed Postgres usually refuses an unencrypted connection
  while pg's default is no TLS at all, so an unconfigured install
  pointed at one would crash with `no pg_hba.conf entry … no
  encryption` and no hint as to why. In production a guess is refused
  outright: not-local, no bundle, `AEOLUS_DB_SSL` unset is a boot failure
  (ADR 0024). Outside production it warns once, with the password
  redacted. This helper is the only place TLS is wired for `@aeolus/db`,
  the migration runner and pg-boss.
- **Pool error handling**: `db()` attaches an `'error'` listener
  (`onPoolError`) to every `pg.Pool` it creates. pg-pool re-emits an
  idle client's socket error on the pool, and Node treats an `'error'`
  event with no listener as an uncaught exception — so without it a
  server-side disconnect of an idle connection (a managed-database
  failover, a Postgres restart, `pg_terminate_backend`; SQLSTATE
  `57P01`) would crash api, ws and worker even though the pool had
  already discarded
  that client and the next checkout opens a fresh one. The listener
  logs one line and returns. Surfaced 2026-09-12 by the E2E teardown
  (the testcontainer stopped while the shared pool still held an idle
  client, exit code 1 after every test had passed), not by an incident.
  Pinned by `tests/integration/db.pool.test.ts`, which terminates an
  idle client's backend and asserts the pool still serves queries.

## Backups and recovery

Aeolus does not back itself up. What it does is make a backup of the two
stores sufficient, and make a rebuild from object storage alone possible
when it is not.

**What has to be backed up.** Document state spans both stores and
neither alone is complete: compaction snapshots live in object storage,
and the update tail since the last snapshot lives only in
`doc_updates`. A self-hoster needs a Postgres dump (`pg_dump`, or the
provider's point-in-time recovery) *and* a copy of the bucket, taken
close enough together that the pair is coherent. Object versioning on
the bucket, where the provider offers it, is what covers a mass delete
or overwrite that bypassed the in-app History.

**Sidecar manifests** make the harder case survivable.
`packages/crdt/src/manifest.ts` writes `docs/<yjsDocId>/manifest.json`
next to every snapshot — `{ schema:1, yjsDocId, docId, title, engine,
ownerEmail, archivedAt, deletedAt, path, writtenAt }`. The importer at
`apps/api/src/bin/restore-from-s3.ts` walks the bucket, fetches each
manifest and the latest `snap-*.ydoc`, and re-derives `docs`,
`doc_files`, `doc_snapshots` rows and stub users into a fresh database.
`apps/api/src/bin/backfill-sidecar-manifests.ts` populates manifests
one-shot for a bucket that predates the "snapshot writes a manifest"
invariant. Email is the durable owner key, because user UUIDs differ
across database recreations, and the schema is versioned (`schema: 1`)
so a partial rollout cannot import garbage.

`doc_collaborators` and `docs.owner_id` cannot be inferred from the
bucket. After a rebuild from object storage alone, re-establish them
through the normal admin user-management and collaborator flows.

## Project bundle download

`GET /docs/:id/download.zip` (read access on the doc) streams every
file in the project as a single ZIP archive: text files are
rendered from their current Yjs state, blob files are copied
verbatim from S3. The route uses a tiny in-tree "store"-mode ZIP
writer (`apps/api/src/zip.ts`) to avoid a new runtime dependency;
the per-doc 200 MB cap keeps the resulting archive comfortably in
memory. The Download project button next to Download PDF in the
editor TopBar is the only caller today.

## Compile pipeline

- **Engines.** Tectonic `0.15.0` and Typst `0.12.0` binaries are pinned
  by SHA-256 and baked into the `aeolus-worker` Docker image
  (`Dockerfile.worker`). The image is `debian:bookworm-slim` with
  `fontconfig`, `ca-certificates`, and `tini`. At build time the
  Dockerfile runs a sample `\documentclass{article}` document through
  Tectonic so the bundle for `article.cls`, `inputenc`, and `amsmath` is
  cached into `/opt/tectonic-cache` and shipped inside the image. At
  runtime Tectonic pulls additional packages on demand from the public
  TeX Live bundle relay and caches them in the same dir, which
  `docker-compose.yml` keeps in the `tectonic-cache` named volume —
  without it the container re-downloads several hundred megabytes every
  time it is recreated, and the first compile after every restart takes
  minutes. `AEOLUS_TECTONIC_BUNDLE` points the engine at a bundle you
  host yourself, which is how an instance with no outbound network
  compiles at all; see `docs/RUNBOOKS/tectonic-bundle.md`. ADR 0011
  has the trade-offs.
- **Queue.** `pg-boss` queue `aeolus.compile`, backed by the same
  Postgres database as everything else. pg-boss creates its own `pgboss.*`
  schema on first connect; jobs are isolated from app tables. Compile
  failures surface to the user via `compile_results.error` rather than
  being retried automatically.
- **Job flow.** `POST /docs/:id/compile` reads the doc via the ACL
  helper, loads the current Yjs snapshot, computes `rev = max(seq)`,
  inserts a `compile_results` row with `status='queued'`, and enqueues
  `{ docId, engine, rev, userId }`. The worker in
  `apps/compile-worker/src/worker.ts` claims the job, marks
  `status='running'`, loads the entrypoint Yjs doc via the same
  `loadDoc` helper the editor uses, writes the source text into a
  fresh `mkdtemp` workdir, AND walks every other `kind='text'`
  row in `doc_files` — hydrating each via its own `yjs_doc_id`
  and writing the rendered source at the file's `path`, so
  `\input{frontmatter}` against a sibling tex file resolves at
  compile time (issue #36 / #44). Spawns the compiler with
  `shell:false` and a constrained env (`PATH`, `HOME`,
  `TECTONIC_CACHE_DIR`, `XDG_CACHE_HOME`), caps stdout/stderr at
  64 KiB, enforces a 30 s wall clock (configurable), and always
  cleans the tempdir. On success it uploads the PDF to
  `compiled/<docId>/<rev>.pdf` in the same bucket used for doc
  snapshots and marks the row `status='success'`. On failure it
  stores the engine's stderr snippet in `compile_results.error`.
  On success it also runs `pdf-fonts.ts` over the bytes (#80): every
  `FontDescriptor` without a `FontFile`/`FontFile2`/`FontFile3` is a
  font the PDF names but does not carry, and each becomes an
  author-facing line in `compile_results.warnings`. The scan is
  dependency-free (the descriptors sit in plain objects or in
  FlateDecode object streams, which `zlib` inflates), skips the
  standard 14, and can never fail a compile that passed. It exists
  because xdvipdfmx says nothing when a font's `fsType` forbids
  subsetting and PDF.js substitutes the missing font in the preview —
  so the author sees a correct-looking document, and the first person to
  see the blank tables is whoever they sent the PDF to.
  A failure to *launch* the engine is mapped to a sentence first:
  `apps/compile-worker/src/compile-error.ts` turns Node's
  `spawn tectonic ENOENT` into "The tectonic compile engine is not
  installed on the compile worker … not with your document", keeping
  the raw errno on a second line for whoever is on call. That string
  lands in the status bar, the logs pane and the error card at once,
  so a missing binary or a non-executable mount used to read to the
  author as though their LaTeX were at fault.
- **Progress.** The editor polls. The worker used to `NOTIFY` a
  `aeolus_compile_events` channel on every state change; nothing had
  subscribed to it since the UI moved to polling, and it was removed
  (see § Process boot). The one Postgres notification still in use is
  `aeolus_room_evict`, which evicts a stale editor room rather than
  carrying progress — see § Collaboration & persistence.
- **Status API.** `GET /docs/:id/compile/:jobId` returns the
  `compile_results` row (including `warnings`, always an array) plus,
  on success, a presigned URL for the PDF minted by the
  `presignCompiledPdf` hook wired into `ServerContext`.
- **Restore API.** `GET /docs/:id/compile/latest` returns the newest
  *successful* compile for the doc (204 when there is none, per ADR
  0018), so the editor can put a PDF on screen the moment it mounts
  instead of leaving the preview empty until a fresh compile lands
  (issue #72). It carries **`is_current`**, and that flag is what lets
  the compile-on-open be skipped entirely.

  `is_current` cannot be a `rev` comparison. `rev` is `MAX(seq)` of the
  **main** file's Yjs doc, and per ADR 0013 every sibling text file has
  its own `yjs_doc_id` — so editing `chapter2.tex`, or touching an
  asset, never moves it. Instead `isCompileCurrent` asks whether
  anything about the project is newer than the compile's `finished_at`:
  `doc_updates.created_at` (a text edit in any file),
  `doc_snapshots.updated_at` (a compaction), or `docs.updated_at` (a
  title change, and any structural file change — see below). The
  comparison runs entirely inside SQL against the row's own timestamp,
  never a JS `Date` round-trip, because Postgres keeps microseconds and
  a `Date` keeps milliseconds. Every unknown resolves to `false`: an
  unnecessary compile costs seconds, a stale PDF presented as final
  costs trust in the preview.
- **`docs.updated_at` is the project's structural change marker.** The
  file and asset routes stamp it via `touchProject`
  (`apps/api/src/project-touch.ts`) on every create, rename, upload and
  delete. This exists because a `MAX(doc_files.updated_at)` cannot see
  a **delete** — removing a row only ever lowers the maximum — so a
  deleted chapter would have left `is_current` true and kept the stale
  PDF on screen. It also makes the workspace list's `ORDER BY
  updated_at DESC` mean what it implies: adding a chapter now moves the
  project up "recently modified", which it previously did not.
- **Security.** Compile runs as the unprivileged `compiler` user in
  the image, never shells out (`spawn` with an args array and
  `shell: false` — user source is written to a file, never
  interpolated), runs against the pre-warmed cache, enforces the 30 s
  timeout with `SIGKILL`, and bounds captured stdout/stderr. There is a
  `USER compiler` directive and no `--privileged`.
- **Filesystem confinement (ADR 0022).** A TeX document can read any
  file the process can — `\input{/etc/passwd}` is a valid document — so
  the engine is wrapped in `aeolus-sandbox`, a small Landlock helper
  compiled from `apps/compile-worker/native/aeolus-sandbox.c` in its own
  Docker stage so gcc never reaches the runtime image. `buildSandboxArgv`
  in `runner.ts` grants read+write on the workdir and the Tectonic cache,
  read-only on the engine binary and the handful of system paths a
  static-musl binary plus fontconfig need (`/usr`, `/lib`, `/lib64`,
  `/etc/ssl`, `/etc/fonts`, `/etc/resolv.conf`, `/dev/urandom`,
  `/dev/null`), and denies everything else. The wrapper is applied
  before exec, so it confines the engine and anything it spawns; the
  Landlock ABI is negotiated at runtime, so the build's kernel headers
  do not have to match the host's kernel.

  `AEOLUS_SANDBOX_MODE` selects the mode and **defaults to `audit`**,
  both in `Dockerfile.worker` and in `docker-compose.yml`. `audit`
  attempts to apply the ruleset, logs the verdict, and runs the engine
  either way — it cannot break a new install. `enforce` applies it or
  fails closed: on a kernel without Landlock, or under a container
  runtime whose seccomp profile hides it, every compile fails. Turn it
  to `enforce`, after reading the boot line the worker prints:
  `[compile-worker] sandbox mode=audit; aeolus-sandbox: landlock
  enforcing (ABI v2)` means `enforce` will work, `landlock UNAVAILABLE
  (…)` means it will refuse every compile, and the parenthesised reason
  says which of "kernel too old", "disabled at boot" and "blocked by a
  seccomp filter" it is. With the variable unset no sandbox is applied
  at all, and the worker says exactly that.
  `.github/workflows/docker.yml` greps for that line, so a worker that
  silently stopped reporting its sandbox state fails CI.
- **Frontend.** Compile is triggered explicitly: once when the doc
  first loads (compile-on-open), and on every Compile button click
  or `Cmd/Ctrl+S` press. There is no live auto-compile-on-edit —
  Yjs already streams every keystroke to the WS server (which
  persists to Postgres), so user content is never lost between
  compiles. The editor calls `POST /docs/:id/compile`, polls the
  compile status route, and renders the resulting PDF via PDF.js in
  the side pane when `success` arrives.
- **SyncTeX.** Tectonic compiles run with `--synctex`; the worker
  parses the resulting `.synctex.gz` into a compact JSON map (keyed
  by source filename and PDF page) and uploads it to
  `compiled/<docId>/<rev>.synctex.json`. The status route advertises
  it as `synctex_url`; the SPA fetches it on success and uses it for
  bidirectional jumps:
  - Editor → PDF: the "Show in PDF" button (and Cmd/Ctrl+J) finds
    the first record at-or-after the current cursor line and
    scrolls the PDF preview to that page, briefly flashing a brand-
    coloured ring around it.
  - PDF → editor: clicks on a rendered PDF page resolve the closest
    synctex record on that page and dispatch a CodeMirror selection
    onto the matching source line. Cross-file reverse jumps are
    deferred — clicks on a record from another file are ignored
    until the multi-file file-tree integration plumbs path-based
    file lookup.
  Typst doesn't currently emit a synctex equivalent, so the column
  stays null for typst compiles and `GET /docs/:id/synctex/latest`
  answers **204** — see `docs/DECISIONS/0018-204-for-absent-
  subresources.md`. The editor fetches that endpoint on every mount,
  so answering 404 meant every typst document logged a console error
  and a failed request on every page load. 404 there now means only
  "no such doc"; 403 means "no read access". Parser shape:
  `apps/compile-worker/src/synctex.ts`; client integration:
  `apps/web/src/lib/synctex.ts` and `components/PdfPreview.tsx`.

## Asset uploads

- **Storage.** Assets are written to object storage under
  `assets/<docId>/<uuid>.<ext>` and recorded as `doc_files` rows with
  `kind = 'blob'` — path, MIME type, size in bytes, storage key. (The
  `/assets` routes are a thin twin of the `/files` ones over the same
  service.)
- **Limits.** 25 MB per file, 200 MB total per document, enforced
  server-side. Only a MIME allowlist is accepted: `png`, `jpg`, `pdf`,
  `bib`, `cls`, `sty`, `ttf`, `otf`, `csv` (matched by extension, not
  the client-supplied `Content-Type`).
- **Filename safety.** Client filenames are sanitised to ASCII
  alphanumerics, dots, hyphens, and underscores. The storage key is
  always a UUID; the display name is the sanitised original.
- **Endpoints** (`apps/api/src/routes/assets.ts`):
  - `POST /docs/:id/assets` — multipart upload (`@fastify/multipart`).
    Requires `assertCanWrite`. Returns 201 with the new asset metadata.
  - `GET /docs/:id/assets` — lists all assets for a doc.
    Requires `assertCanRead`.
  - `DELETE /docs/:id/assets/:assetId` — removes the row, and the
    object when nothing else references its key (see § Live PDF
    preview, "Blob delete keeps shared bytes"). Requires
    `assertCanWrite`.
- **Compile integration.** Before spawning the engine, the compile worker
  walks the document's `doc_files` rows, fetches each `kind = 'blob'`
  object from storage, and writes it into the compile tempdir at the
  file's own path, so `\includegraphics{images/figure.png}` resolves
  exactly as the project's file tree reads. A bare root-level font or
  image is additionally mirrored under `fonts/` or `images/` for
  projects that never organised themselves into folders.

## Live PDF preview

- **Split pane.** The editor renders a resizable two-pane layout:
  CodeMirror on the left, PDF.js preview on the right. The split
  percentage is persisted to `localStorage` and restored on reload.
- **Compile trigger.** A "Compile" button fires `POST /docs/:id/compile`
  immediately. The same call also fires once on doc load
  (compile-on-open) and on `Cmd/Ctrl+S`. Live auto-compile-on-edit
  was removed in favour of these explicit triggers — recompiling
  every couple of seconds while the user types is expensive and
  visually noisy, and Yjs persistence already protects content
  between compiles. Compile state (`idle`, `running`, `success`,
  `error`) is shown in the bottom status bar.
- **PDF.js rendering.** On compile success, the API returns a presigned
  URL for the PDF. The web client passes it to `pdfjs-dist`'s
  `getDocument`, renders the first page onto a `<canvas>`, and scales to
  fit the container width at up to 2× DPR.
- **File tree panel.** A collapsible sidebar (`apps/web/src/components/
  FileTreePanel.tsx`) lists every project file (text, blob, folder) with
  size, supports click-to-upload (↑ file → project root, ↑ folder →
  structure preserved), drag-and-drop of OS files onto the panel (root)
  or onto a folder row (uploads into that folder), row drag between
  folders, inline rename — a `/` in the rename input moves the file —
  and deletion (✕ twice within 4s) for owners and editors.
- **Blob delete keeps shared bytes.** Docs forked from a template
  reference the template's S3 objects by storage key, so one object can
  back many `doc_files` rows. `DELETE /docs/:id/files/:fileId` (and the
  legacy `/assets` twin) drops the S3 object only when the deleted row
  was the last `doc_files` reference and no project checkpoint pins the
  key (#82). Until then only the row goes.

## Templates

- **Storage model.** A template is a metadata row in `templates`
  paired with a backing `docs` row (`is_template_doc = true`) linked
  via `templates.yjs_doc_id`. The backing row lives in the normal
  Yjs storage layer (`doc_updates`, `doc_snapshots`,
  `doc_checkpoints`, blob store) — templates reuse the exact same
  persistence path as user documents, with zero duplicate plumbing.
- **Admin CRUD.** `POST /templates` (admin) creates both rows in a
  single transaction. `GET /templates` returns all non-deleted
  templates for admins and only `is_published = true` templates for
  end users. `GET /templates/:id` leaks nothing to non-admins for
  unpublished templates (404). `PATCH /templates/:id` (admin)
  updates name/description/publish state — the publish flag is
  accepted as **either** `is_published` (the spelling every response
  uses, and the documented one) **or** `isPublished`, which the web
  client shipped for months; snake_case wins if both are sent. Before
  issue #73 only camelCase parsed, so PATCHing back the object a GET
  had just returned failed with `invalid_body`. `DELETE /templates/:id`
  (admin) soft-deletes both the template and its backing doc.
- **Admin editing.** Admins open a template via
  `/admin/templates/:id`, which loads the backing doc in the normal
  editor and speaks y-websocket to `apps/ws` using the backing
  `yjs_doc_id`. Multiple admins can collaborate on a template in
  real time.
- **ACL.** `resolveRole` treats any `is_template_doc = true` row
  specially: admins get `owner`, everyone else gets `none`. This
  means non-admins are rejected with close code 1008 if they ever
  learn a template's backing doc id and try to open it directly,
  and `GET /docs` filters out `is_template_doc = true` rows so
  admins never see template-backing docs mixed into their personal
  document lists.
- **Fork flow.** `POST /templates/:id/fork` (any authenticated user,
  subject to `is_published` for non-admins) walks every text file
  in the template's project, hydrates each via its own
  `yjs_doc_id`, mints fresh ids on the forked doc (main keeps the
  legacy `yjs_doc_id == docs.id` convention; siblings get random
  UUIDs), and persists each snapshot as `seq = 0` on the
  corresponding new yjs_doc_id. Issue #36 fix — the pre-fix path
  only carried main, silently dropping any `\input{}`-included
  sibling tex file at compile time. Blob rows are copied as
  references to the same S3 keys (intentional cost-saving;
  forks share bytes). Inserts a new `docs` row owned by the
  caller with `forked_from_template = :id`. Response carries
  `text_files_copied` and `blobs_copied`. The endpoint returns
  `{ doc_id, title, text_files_copied, blobs_copied }`; the
  client navigates to `/docs/:id`. The forked doc is fully
  detached — edits never flow back to the template.
- **Not implemented and not planned as of 2026-09-13.** Thumbnails
  (pre-compiled PNG previews); the thumbnail S3 key column exists
  but is unused.

## Claude-assist feature

- **One instance-wide Anthropic key**, read from the
  `ANTHROPIC_API_KEY` environment variable by the api process. Users
  never see or manage a key. Leave it unset and the feature is simply
  absent — no errors, no half-working panel.
- **Endpoint:** `POST /ai/assist` accepts `{docId, selection,
  instruction, preferHigherQuality?}`. ACL-gated — caller must have
  read access to the document. Returns `text/event-stream` (SSE)
  with events: `chunk` (streamed text deltas), `usage` (token
  counts including cache metrics), `error`, `done`.
- **Quota endpoint:** `GET /ai/quota` returns the caller's remaining
  hourly/daily request budget and daily token budget.
- **Models:** `claude-sonnet-4-6` by default, `claude-opus-4-7`
  when `preferHigherQuality: true` (`apps/api/src/ai/client.ts`).
- **Prompt caching** is mandatory. Two `cache_control: {type:
  "ephemeral"}` breakpoints on the system prompt:
  1. The base system prompt (writing-assistant persona, formatting
     rules).
  2. The brand context (tone, style guidelines).
  Both are frozen strings — no per-request interpolation — so the
  cache prefix is deterministic across all calls. On the second and
  subsequent calls with the same stable prefix, the API reports
  `cache_read_input_tokens > 0`, confirming the cache hit. See
  `docs/DECISIONS/0005-prompt-caching.md` for the full rationale.
- **Implementation files:**
  - `apps/api/src/ai/client.ts` — thin wrapper around
    `@anthropic-ai/sdk` that enforces the cache blocks above and
    streams via `client.messages.stream()`.
  - `apps/api/src/ai/quota.ts` — reads/writes the `ai_quota` table;
    checks per-user per-hour (default 30), per-day (default 200),
    and per-day-tokens (default 50 000) caps.
  - `apps/api/src/ai/spend.ts` — global circuit breaker. Daily spend
    ledger stored in the `ai_global_spend` table (one row per UTC
    day, atomic upsert). When the configured cap (env
    `AEOLUS_AI_DAILY_CAP_CENTS`, default $100) is reached, all
    subsequent `/ai/assist` calls return `503 quota exceeded`.
  - `apps/api/src/routes/ai.ts` — route handler registering
    `POST /ai/assist` and `GET /ai/quota`.
  - `packages/shared/src/ai.ts` — TypeScript types shared between
    the API and web client (`AiAssistRequest`, `AiAssistEvent`,
    `AiQuotaResponse`).
- **Abuse controls:**
  - Per-user rate limit: default 30 req/hr, 200 req/day, configurable
    in the `ai_quota` table by admins.
  - Per-user daily token budget (default 50 000 tokens) enforced
    server-side.
  - **Global** daily spend cap (default $100, configurable via
    `AEOLUS_AI_DAILY_CAP_CENTS`) with a Postgres-backed circuit
    breaker (`ai_global_spend` table). When hit, returns
    `503 quota exceeded`. Set it in cents per day; it applies across
    the whole instance.
  - All requests logged to `ai_requests(user_id, doc_id,
    input_tokens, output_tokens, cached_input_tokens, cost_usd_cents,
    instruction, status, created_at)` for audit and chargeback.
- **Web UI:**
  - Command palette (Cmd+K / Ctrl+K) with preset actions: "Ask
    Claude about selection", "Tighten this paragraph", "Convert to
    theorem environment", "Fix bibliography". Custom free-text
    instruction supported.
  - Streaming response appears in a side panel (320 px, right edge);
    user can **Accept** (replaces current selection in the editor)
    or **Dismiss**.
  - **AI error assistant**: when a compile fails, the Logs tab
    surfaces an "Ask Claude to fix" button. Clicking it opens the
    AI panel with `errorContext` set to the stderr tail and
    `selection` set to a **window around the failing line** (#57):
    `parse-compile-log.ts` extracts the line (Tectonic `l.N`, Typst
    `main.typ:N:C`), `error-fix-window.ts` widens it to whole
    paragraphs — up to 20 lines each side, snapped to blank lines,
    hard-capped at 40 — and the editor selects exactly that range,
    so Accept replaces the excerpt and nothing else. The panel shows
    the scope ("Fixing lines 41–63 of 180"). Only when the log names
    no line does it fall back to the full source, and the panel says
    so. Before #57 the whole document was sent and replaced on every
    fix — slow, expensive, and able to rewrite lines that were fine.
    The system prompt's compile-error rule activates and tells Claude
    the source is an excerpt to return span-for-span. The same
    `/ai/assist` endpoint serves both rewrite and error-fix modes —
    the `errorContext` field is the discriminator.
  - Quota indicator in the status bar shows remaining hourly budget.
- No writes to the document are performed server-side — the client
  decides whether to accept/insert/replace.

## Inline comments

Comments are stored Yjs-natively (no new tables, no new API). See
ADR 0014 for the trade-off analysis. Each Y.Doc that holds a text
file's source also carries a `Y.Map('comments')` keyed by thread
id; each thread is itself a `Y.Map` with:

- `from`, `to` — encoded `Y.RelativePosition` bytes anchoring the
  thread to a source range that survives concurrent edits.
- `resolved`, `authorId`, `authorName`, `createdAt` — metadata.
- `preview` — selection text captured at creation, used by the
  sidebar so stale anchors still show context.
- `body` — the initial message.
- `replies` — `Y.Array` of `{ authorId, authorName, text,
  createdAt }` maps.

Files of interest:

- `apps/web/src/lib/comments.ts` — CRUD helpers, anchor resolution,
  observer wiring (`onThreadsChange`).
- `apps/web/src/lib/comments-decoration.ts` — CodeMirror
  `StateField` driving an underline mark over each anchored range;
  the editor effect dispatches `setThreadsEffect.of(threads)` on
  every change.
- `apps/web/src/components/CommentsPanel.tsx` — sidebar tab listing
  open / resolved threads with reply, resolve, reopen, delete
  actions and a "Show resolved" toggle.
- `apps/web/src/components/TopBar.tsx` (via `doc-editor.tsx`) —
  Comment button creates a thread from the current selection.

ACL rides on the existing Yjs channel: `assertCanRead` controls
who joins the room (and therefore who sees threads), and
`assertCanWrite` controls who can mutate (creating, replying,
resolving, deleting). Viewers see threads but cannot interact.

## Audit log

Every authentication and major mutation event lands in
`audit_events`. The list is
visible to admins for 30 days at `/admin/audit` (route table in
`apps/web/src/routes/admin-audit.tsx`); the API is
`GET /api/admin/audit-events` with optional `action`, `actor_id`,
and `before` filters. Retention is enforced as a side effect of
each list call — no separate scheduler. Full design rationale and
the list of audited actions is in ADR 0015.

The helper module `apps/api/src/audit.ts` exposes
`emitAudit(db, …)` for route handlers and `auditFromRequest()` to
pull the request-scoped `ip` and `user_agent`. Insert failures are
swallowed and logged to stderr so an audit-write outage never
aborts the user's primary action.

## Frontend (webapp + Electron)

- **Web**: React 18, Vite 5, TypeScript strict, Tailwind CSS
  (utility classes only; minimalist look enforced by the
  `@aeolus/shared/ui` design-system shim — Button, Input, Card,
  Toast, ConfirmInline). Lives at `apps/web/`. Since 2026-09-13 every
  request goes through `lib/api.ts` (the two raw fetches that remain —
  multipart upload, assist SSE — report a 401 to the same handler);
  destructive actions confirm inline with `ConfirmInline` rather than
  `window.confirm`/`window.prompt`, which an embedding iframe can block;
  the toast host is two persistent live regions (polite status, assertive
  alert) with a Dismiss button per toast; the editor's connection
  indicator and close-code banner show sentences (`lib/ws-labels.ts`,
  `authFailedMessage`), not protocol states or codes. The pdf/logs
  pane is a real tablist (`components/RightPaneTabs.tsx`, roving
  tabindex, arrow keys); the command palette is a native `<dialog>`
  over a `--backdrop` scrim; the split handle is a keyboard-operable
  `role="slider"`. Shadows and the comment highlight resolve through
  tokens (`shadow-card`/`-menu`/`-dialog`, `color-mix` on `--accent`);
  chrome carries `print:hidden`; CodeMirror's brand hexes come from
  the Tailwind preset via a `__BRAND_PALETTE__` Vite define, so the
  editor theme cannot drift from the tokens.
- **Editor**: CodeMirror 6 with:
  - `@codemirror/lang-stex` for LaTeX.
  - `y-codemirror.next` binding to the Yjs doc via
    `y-websocket`, pointed at `apps/ws`.
  - JetBrains Mono via `@font-face` in `src/styles/globals.css`.
  - `EditorView.lineWrapping` so prose-heavy sources soft-wrap at
    the editor's current width — wrapping prefers whitespace
    boundaries and only fragments a token when a single word
    exceeds the line, and re-flows whenever the split-pane drag
    or window resize changes the host width.
  - The editor loads the LaTeX `stex` StreamLanguage for both
    engines (`apps/web/src/hooks/useDocWsConnection.ts`); no Typst
    grammar is wired as of 2026-09-13.
- **PDF preview & compile logs**: the right pane is a tab strip
  (`PDF` / `Logs`) above a viewer area. PDF tab uses `pdfjs-dist`
  to render the latest compile result. Logs tab (`apps/web/src/
  components/CompileLogs.tsx`) renders the stderr tail stored in
  `compile_results.error`, broken into colour-coded blocks
  (errors → brand red border, warnings → amber, info → grey)
  with a Copy button and a header showing duration + error/warning
  counts. The pane auto-switches to Logs on compile failure or
  timeout so the user never has to hunt for it.
- **Editable doc title**: the editor's secondary header shows the
  doc title as click-to-edit. Click → input, Enter or blur saves
  via `PATCH /api/docs/:id`, Escape cancels. ACL is enforced
  server-side (`apps/api/src/routes/docs.ts`); only writers can
  rename.
- **Routing**: tiny in-repo router (`apps/web/src/router.tsx`,
  ~80 lines on top of `window.history` + `popstate`). Routes
  registered in `apps/web/src/App.tsx`: `/`, `/login`, `/passphrase`,
  `/docs`, `/docs/:id`, `/settings`, `/tokens`, `/guide`,
  `/guide/:section`, `/admin`, `/admin/diagnostics`,
  `/admin/templates`, `/admin/templates/:id`, `/admin/users`,
  `/admin/audit`. `/passphrase` is the setup and change screen; the
  `PassphraseGate` component sends anyone still on a generated
  credential there from wherever they land. `/guide` and
  `/guide/:section` carry the in-app Guide (below). The Link
  component runs the user-supplied onClick first so callers can opt
  out of SPA-routing via `preventDefault()`; pinned by
  `apps/web/src/router.test.tsx`.
- **Public routes**: `main.tsx` registers the 401 handler that
  bounces an expired session to `/login`, and skips it for a list
  of public prefixes — `/login` **and `/guide`**. The guide is
  linked from the login card for someone who cannot get in, and
  the session probe 401s for exactly that person; without the
  exemption the link redirected straight back to `/login`, so the
  affordance existed and did nothing. Pinned by
  `tests/e2e/guide.spec.ts`. The same file registers the
  `passphrase_setup_required` handler, whose exempt list is
  `/passphrase` and `/guide`.
- **The Guide** (`/guide`): a sticky table-of-contents plus a single
  reading column, 19 deep-linkable sections rendered one at a time from
  a registry in `apps/web/src/routes/guide.tsx`. Authored as structured
  React — no markdown runtime and no CDN, so the bundle stays
  self-contained — and lazy-loaded into its own chunk. The TOC is
  rendered twice (a `<details>` disclosure below `lg`, a sticky
  `<aside>` above it), which is why component tests query the heading
  role rather than raw text.

  Screenshots live at `apps/web/public/guide/*.png` and are served at
  `/guide/*.png`. They are captured by driving the real app against
  a seeded harness of invented people and documents on the reserved
  `example.com` domain — never a mockup, never real user data — as one
  canonical set in the light theme, because a guide teaches where things
  are, not what colour they are. `tests/e2e/guide.spec.ts` fetches every
  referenced image and asserts it is served, is a PNG and is not
  truncated (an `<img>` whose file is missing renders a broken image and
  nothing in a diff or a typecheck notices), and asserts the prose names
  no address outside the reserved forms.
- **Sign-in**: `/login` is a form — email and passphrase — that POSTs to
  `/api/auth/login` and, on success, navigates to `/passphrase` when the
  response says `must_set_passphrase` and to `/docs` otherwise. The
  plaintext is dropped from component state the moment it is spent.
  There is no redirect to anywhere else and no auth ceremony beyond
  that. Session state is held in a small module-level store
  (`apps/web/src/lib/session.ts`) that polls `/me` on mount and on
  explicit `refreshSession()` calls. Sign-out is `DELETE
  /api/me/session` (idempotent, clears the cookie server-side);
  the TopBar fires the request and then `window.location.assign`s
  to `/login` to drop session-derived module state.
- **API client**: `apps/web/src/lib/api.ts` — a thin `fetch`
  wrapper (`api.get/post/patch/delete`) that always sets
  `credentials: 'include'` and prefixes `/api`. Vite dev-server
  proxies `/api` → `apps/api` and `/ws` → `apps/ws` so the
  browser sees one origin and no CORS is needed. A 401 on any
  call fires the `setUnauthenticatedHandler` hook (registered
  once in `apps/web/src/main.tsx`), which calls `clearSession()`
  and `window.location.assign('/login')`. The handler skips the
  redirect on the public route `/login` so
  the unauth `/me` probe that drives `useSession()` doesn't
  loop. Without this hook, a stale session would surface as the
  API's 401 body inside whichever feature made the call —
  e.g. "Compile failed — Not signed in" rendered in `CompileLogs`
  because `triggerCompile` mapped the `ApiRequestError.message`
  straight into `setCompileError`.
- **Hosting the SPA**. The SPA is served by `apps/api` itself, not a
  separate web service. `Dockerfile.api`'s `web-build` stage builds
  `apps/web` and the runtime image carries only the dist.
  `apps/api/src/server.ts` registers all REST routes under `/api` (so
  the SPA owns root for client-side routing) and uses `@fastify/static`
  + `setNotFoundHandler` to serve `index.html` for any non-`/api` GET
  that doesn't match a built asset. `/healthz` stays at root, which is
  where the container health check points. Three consequences worth
  keeping in mind:
  - The vite dev proxy passes `/api/*` through unchanged (no
    rewrite), so the dev shape mirrors a real deployment. `/ws` is
    proxied to `apps/ws` with the prefix stripped, exactly as the
    Caddyfile's `handle_path /ws*` does.
  - Adding a new top-level SPA route (`/foo`) costs nothing at
    the api layer — it falls through to the SPA fallback.
    Adding a new top-level api route requires putting it under
    `/api/*`.
  - The shell is rewritten on its way out rather than served as a file,
    which is why `index: false` is set on `@fastify/static` and why the
    rewrite has to run on **both** paths that emit it: `GET /` and the
    SPA fallback. Miss the second and a deep link like `/docs/:id`
    renders unstamped while `/` renders correctly.

- **Runtime configuration, stamped into the shell.**
  `stampConfig` in `apps/api/src/appearance.ts` injects
  `<script type="application/json" id="aeolus-config">` immediately
  after `<head>`, and `apps/web/src/lib/runtime-config.ts` reads it once
  at module load. Today it carries one value, `wsUrl`, from
  `AEOLUS_WS_URL`.

  This replaced a `VITE_WS_URL` build arg. A build arg freezes the value
  into the bundle, so the published image only worked for the hostname
  it was built for and every self-hoster had to rebuild it; now one
  image runs anywhere and the operator sets an environment variable.
  Empty means the same origin at `/ws`, which is what the compose stack
  serves and what the Vite dev server proxies, so most installs set
  nothing. A JSON blob in a non-executing `<script>` needs no CSP hash
  and cannot run; `</` is escaped so no value an operator types can end
  the element early. The same rewrite carries `data-theme` from the
  `aeolus_theme` cookie, so the first paint is already in the right
  theme with no flash and no pre-paint script to hash into the CSP.
- **Electron**:
  - `apps/electron` builds per-OS via `electron-builder` (v26). The
    main process is ESM (`"type": "module"`, tsconfig extends the base
    with NodeNext) since 2026-09-13.
  - `src/main.ts` creates a single `BrowserWindow` with
    `nodeIntegration: false`, `contextIsolation: true`,
    `sandbox: true`. A packaged build loads `http://localhost:8080`, a
    development run `http://localhost:5173`; `AEOLUS_APP_URL` overrides
    both and is what anyone pointing the shell at their own instance
    sets. This is Electron-only; the api's own public URL is
    `AEOLUS_PUBLIC_BASE_URL` (`apps/api/src/bin/server.ts`). Before
    2026-09-13 the packaged default was the dev server.
  - Navigation policy (`src/navigation.ts`, pure functions tested in
    `tests/electron/navigation.spec.ts`): `will-navigate` and
    `setWindowOpenHandler` allow **one** origin, the app's own —
    sign-in is a form served by the app itself, so there is no identity
    provider to add to the list. Anything else — a link in a document, a
    URL in a comment — is handed to the system browser (http/https only)
    and the shell stays put. No Electron-side CSP: the api's headers
    govern the pages it serves (ADR 0025).
  - `src/preload.ts` exposes `window.aeolus = { version, platform }`
    via `contextBridge`; the values come from the main process over a
    synchronous IPC call (`app.getVersion()` — the old
    `npm_package_version` was `0.0.0` in every packaged build).
  - Standard menu bar: File, Edit, View, Window, Help → Aeolus guide
    (loads `/guide` in-app). DevTools only in a development run.
    macOS re-opens from dock; non-macOS quits on window close.
  - `--headless-test` flag: auto-exits with code 0 after 2 s once
    the page loads (used by the smoke test in CI).
  - `electron-updater` is wired but dormant: `publish: null`, feed set
    only when `AEOLUS_UPDATES_HOST` is present in a packaged build,
    which no build sets (ADR 0006). The workflow's old "publish to
    updates bucket" step ran `aws s3 sync` with no credentials and was
    removed 2026-09-13.
  - `build/icon.png` (1024 px, the Aeolus mark on its teal tile) is
    what electron-builder derives every platform's icon from. It is
    written by `scripts/build-brand-assets.mjs` from the same
    description of the mark as the favicons.
  - Sign-in is the hosted app's own form, rendered in the same
    `BrowserWindow`; the shell handles no credentials itself.
  - Auto-update: `electron-updater` configured against a generic
    manifest URL. Initialised only when the app is packaged and the
    build-time env var `AEOLUS_UPDATES_HOST` is set. On
    `update-downloaded`, shows a dialog offering "Restart Now" or
    "Later". When `AEOLUS_UPDATES_HOST` is unset — which no build sets —
    auto-update is silently disabled.
  - Targets: macOS dmg (arm64+x64), Windows nsis (x64), Linux
    AppImage (x64).
  - Code-signing: **deferred** (see ADR 0006). All three platforms ship
    unsigned. `electron-builder.yml` and
    `.github/workflows/build-electron.yml` carry every signing and
    notarization hook, gated on GitHub secrets (`APPLE_ID`,
    `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK`,
    `CSC_KEY_PASSWORD`) that are unset. Enabling signing is a
    secrets-only change — no code modifications required.
  - CI: `.github/workflows/build-electron.yml` runs a matrix build over
    macOS, Windows and Ubuntu on pushes to `main`, PRs and `v*` tags,
    producing three platform artifacts per run. There is **no publish
    step**: `--publish never` is passed explicitly, and the
    updates-bucket sync that used to sit at the end of the file ran with
    no credentials configured and could never have worked.

## Fonts & brand assets

Both typefaces are **SIL Open Font License 1.1** and are vendored into
the repo, so a build needs no font vendor and an install needs no CDN:

- **Jost** for the UI — one variable `.woff2` per subset,
  `Jost-latin.woff2` and `Jost-latin-ext.woff2`, weight axis 100–900,
  each with its own `unicode-range` so a Latin-only page never fetches
  the extended subset.
- **JetBrains Mono** for the editor and every monospace surface —
  `JetBrainsMono-Regular/-Medium/-Bold.woff2`.

The files live in `apps/web/public/fonts/`, which Vite copies verbatim
into `dist/fonts/` and the api serves via `@fastify/static`. The licence
texts are in `third_party/Jost-OFL.md` and
`third_party/JetBrainsMono-OFL.txt`. `@font-face` declarations are in
`apps/web/src/styles/globals.css` — one stylesheet, so the cascade order
stays predictable. `apps/web/tailwind.preset.cjs` sets
`fontFamily.sans` to Jost and `fontFamily.mono` to JetBrains Mono, each
with a real system fallback stack.

### The palette

`apps/web/tailwind.preset.cjs` holds two kinds of colour, and the
difference is the thing to remember:

- `ink-*` and `brand-*` are **fixed literal scales**. They do not flip
  with the theme. Reach for them when you mean a specific hue whatever
  the theme is.
- Everything else — `surface`, `page`, `body`, `hairline`, `accent`,
  `success`, `danger`, and the rest — is a `var()`-backed **semantic
  role** that resolves to a custom property from
  `apps/web/src/styles/tokens.css`. That indirection is how the app
  flips theme without touching a single utility class. `bg-white` is
  therefore never correct here: it is Tailwind's literal `#fff` and
  cannot follow a theme.

The brand scale is a **teal**, `brand.50` through `brand.950` with
`brand.DEFAULT = #17a2a4`. `scripts/check-contrast.mjs` is what keeps it
honest: it parses the four theme blocks out of `tokens.css` and the
brand scale out of the preset — the real definitions, not a copy that
can drift — and asserts every foreground/background pair the app
actually paints clears WCAG AA (4.5:1 for text, 3:1 for a boundary or
large text) in light, in system dark, in explicit dark, and in print.
A token missing from one block is itself a failure, because it resolves
to nothing there. The job runs in CI as `pnpm check:contrast`, and its
closing line is "Fix the token, not the threshold."

### Generated assets

`scripts/build-brand-assets.mjs` generates every icon from one
description of the mark — three strokes of moving air on a rounded teal
tile, on a 64×64 grid, the top one lifting into a curl. The SVG is
emitted from the same path strings the PNGs are drawn with through
`Path2D`, so the two cannot drift apart. Outputs, all committed under
`apps/web/public/`: `favicon.svg`, `aeolus-mark.svg` (the mark without
its tile, for use inside the app's own chrome), `favicon-32.png`,
`favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`,
their maskable variants inset into the safe zone, and `og-image.png`
(1200×630, lettered in Jost). It also writes
`apps/electron/build/icon.png` at 1024 px, which electron-builder
derives every platform's installer icon from. `site.webmanifest` is
hand-maintained beside them.

They are committed rather than built in CI, because a browser-tab icon
should not depend on a native canvas binding being installable on
somebody's machine. `pnpm check:brand` runs the same generator with
`--check` and compares SHA-256 digests, so a hand-edited icon fails the
build instead of being silently reverted by the next regeneration. The
script needs `@napi-rs/canvas`, a devDependency of `apps/web`, and reads
`Jost-latin.woff2` straight out of `public/fonts/` for the lettering.

### Editor chrome

The editor ignores the brand palette and uses **Solarized** — Ethan
Schoonover's published hex values, in `apps/web/src/lib/editor-theme.ts`
as a CodeMirror 6 `EditorView.theme` plus a `HighlightStyle` mapped to
the standard Lezer tag set, so it colours the stex stream parser today
and any future Lezer grammar without changes. Solarized is a
deliberately specified code palette whose hues are chosen to keep token
classes apart; the app's own neutrals are chosen to be quiet. Those are
different jobs, and a code surface is the one place worth a second
palette.

`EditorThemeName` is `auto | solarized-dark | solarized-light`, picked
on `/settings` and persisted in `localStorage['aeolus.editor.theme']`
(`EDITOR_THEME_KEY`). `auto` follows the app's resolved polarity, which
`useAppTheme()` publishes as `isDark` — CodeMirror needs the polarity as
a boolean, and a boolean cannot come from a `var()`. The theme lives in
a `Compartment` and is swapped with `reconfigure`, never by remounting
the view: a remount would destroy the `Y.Doc` and reconnect the
WebSocket, so changing a colour would drop the collaborative session.

Where the editor wants a brand presence rather than another Solarized
hue it reads the teal from the Tailwind preset through a
`__BRAND_PALETTE__` Vite define, at steps that clear AA on the ground
they land on — the pale end (200–500) on Solarized dark's `#002b36`,
the deep end (700–900) on light's `#fdf6e3`, nothing in the middle. The
`EDITOR_PAIRS` block in `check-contrast.mjs` is what enforces that, and
it fails if `editor-theme.ts` reaches for a step the preset does not
define.

## Testing strategy

Every requested capability has an integration test; features land only
when that test is green. Test tiers:

1. **Unit (Vitest)**: pure functions only — CRDT helpers, zod schemas,
   the passphrase policy, ACL resolvers, the theme resolver. Fast, no IO.
2. **Integration (Vitest + Testcontainers)**: spins up a real Postgres 16
   container and an in-process blob store, and drives real HTTP routes.
   Covers, among the rest:
   - Sign-in: a wrong passphrase and an unknown address are the same
     answer, the ten-failure lockout, the disabled-account order, the
     forced-setup gate, and the rehash-on-login upgrade
     (`tests/integration/auth.passphrase.test.ts`).
   - Document create/read/update ACL enforcement.
   - Admin override on an arbitrary doc.
   - Template fork produces a detached doc.
   - Yjs update append + snapshot compaction, and a sync frame that
     arrives while the room is still loading.
   - Compile enqueue → PDF in the blob store, LaTeX and Typst.
   - Claude-assist: a mock Anthropic endpoint, asserting the cache
     breakpoints and quota enforcement.
   - Both planes answering the same ACL questions identically
     (`route-acl.test.ts`).
3. **End-to-end (Playwright)**: runs the full stack under a real
   Chromium. Covers the first run (`first-run.spec.ts`), sign-in and
   editing, two browsers converging with live cursors, compile and
   preview, version history, tokens, and the guide.
4. **Compose smoke** (`.github/workflows/docker.yml`): builds all three
   images, brings the stack up with nothing but Docker, reads the
   generated passphrase out of the api's log exactly as a person would,
   signs in with it, is made to choose a real one, writes a document,
   compiles it, downloads the PDF, and opens a second session to confirm
   the edit arrived over the WebSocket. This is the test that the
   install instructions are true.

All tests run on every PR via CI. A test plan doc in
`docs/TEST_PLAN.md` maps each locked feature to the test(s) covering
it; PRs that add features must update this mapping.

## CI/CD

**`.github/workflows/ci.yml`** runs independent jobs in parallel, so a
typecheck error no longer masks a lint error and wall-clock is the
slowest job rather than the sum. Every job starts with the
`.github/actions/setup-pnpm` composite, which owns the
corepack-before-setup-node ordering the pnpm cache depends on.

| Job | What it runs |
| --- | --- |
| `lint` | `pnpm lint` |
| `format` | `pnpm format:check` |
| `gates` | `pnpm check:refs`, `pnpm check:contrast`, `pnpm check:brand` |
| `typecheck` | `pnpm typecheck`, then `apps/web/scripts/check-dead-utilities.mjs` |
| `db-drift` | `drizzle-kit generate` and fails on any diff under `packages/db/migrations/` |
| `openapi-drift` | regenerates `docs/openapi.json` from the running api and fails on any diff |
| `test` | installs pinned Tectonic + Typst, then `pnpm test` |
| `e2e` | Playwright Chromium, `needs: test` so a 25-minute slot is not burned on a unit-test regression |

Three of those deserve a sentence each. `check:refs` refuses to publish
anything left over from the codebase Aeolus was forked out of — internal
hostnames, account identifiers, licensed fonts, colleagues' names. It is
a gate, not advice: if it fires, the reference goes.
`apps/web/scripts/check-dead-utilities.mjs` builds the CSS and asserts
every colour class in the source appears as a selector in it — a Tailwind utility that
resolves to nothing emits no CSS and no error, so the element falls back
to preflight's `border-color:#e5e7eb` and renders a plausible *wrong*
colour rather than an obviously missing one. `openapi-drift` does two
jobs: it keeps the committed description honest, and it makes a
wire-format change show up as a reviewable diff on the PR.

**`.github/workflows/docker.yml`** proves the README's promise — that
`docker compose up` on a machine with nothing but Docker gives a working
Aeolus. It copies `.env.example` to `.env` exactly as the file says to,
generates a cookie secret, builds all three images, starts the stack,
waits for `/healthz`, asserts **every** service is still running (a
worker that exited leaves compiles queued forever while the app looks
fine until someone presses save), greps the worker's log for its sandbox
line, and then runs `scripts/compose-smoke.mjs` through a real browser.

**`.github/workflows/build-electron.yml`** matrix-builds unsigned
installers (ADR 0006) for macOS, Windows and Linux as workflow artifacts
on pushes to `main`, PRs and `v*` tags. There is no publish step.

There is no deploy workflow. Aeolus is self-hosted: the images are built
from the three Dockerfiles at the repo root, and how they reach a server
is the operator's business.

## Deployment

Everything needed to run Aeolus is three files at the repo root:
`docker-compose.yml`, `Caddyfile` and `.env.example`.

```
cp .env.example .env
# set AEOLUS_COOKIE_SECRET — `openssl rand -base64 48`
docker compose up -d
docker compose logs api | grep -A4 "First launch"
```

That last line is not optional flavour: it is how the administrator's
one-time passphrase reaches a person. It is printed once and cannot be
recovered.

### The services

| Service | Image | Why it exists |
| --- | --- | --- |
| `caddy` | `caddy:2.10-alpine` | One origin in front of everything; `/ws*` to ws, everything else to api. The only published port. |
| `api` | built from `Dockerfile.api` | The REST API and the SPA. |
| `ws` | built from `Dockerfile.ws` | The collaborative editing session for each open document. |
| `worker` | built from `Dockerfile.worker` | Tectonic and Typst. Compiles are queued, not synchronous. |
| `postgres` | `postgres:16-alpine` | Documents, users, sessions, the job queue. |
| `minio` | `quay.io/minio/minio` | Object storage for snapshots and uploaded assets. |
| `minio-init` | `quay.io/minio/mc` | Creates the bucket once and exits. |

`depends_on` is ordered by real dependencies: api, ws and worker each
wait on `postgres: service_healthy` and
`minio-init: service_completed_successfully`, and Caddy waits on
`api: service_healthy` and `ws: service_started`. Named volumes hold the
Postgres data directory, the MinIO
data directory, Caddy's certificate store, and — importantly — the
Tectonic cache, without which the container re-downloads several hundred
megabytes of TeX bundle every time it is recreated.

Nothing but Caddy publishes a port. Postgres and MinIO are unreachable
from the host, which is why `AEOLUS_DB_SSL: disable` is correct in this
topology and would not be over a network.

### Serving it on a real hostname

Put the hostname in `AEOLUS_SITE_ADDRESS`, publish 80 and 443 instead of
8080 in `docker-compose.yml`, and set `AEOLUS_COOKIE_SECURE=1`. Caddy
obtains a Let's Encrypt certificate on its own, renews it, and redirects
http to https. `AEOLUS_PUBLIC_BASE_URL` must match: it is what the app
puts in generated links, and it is the Origin the ws process accepts
cookie-authenticated upgrades from — so a wrong value there does not
break sign-in, it breaks editing, quietly.

### The configuration surface

`.env.example` is the reference and carries the reasoning for each
setting; README.md § Configuration has the per-process tables. The ones
that decide the shape of a deployment:

| Variable | Effect |
| --- | --- |
| `AEOLUS_COOKIE_SECRET` | Signs the session cookie. No default; the stack refuses to start without it. Changing it signs everybody out, which is also how you revoke every session at once. api and ws must agree. |
| `AEOLUS_PUBLIC_BASE_URL` | The URL people type. Generated links, and the Origin ws accepts upgrades from. |
| `AEOLUS_SITE_ADDRESS` | What Caddy serves — `:8080`, or a hostname for automatic HTTPS. |
| `AEOLUS_COOKIE_SECURE` | Marks the session cookie `Secure`. Off by default so an http install can sign in at all; turn it on with https. |
| `AEOLUS_BOOTSTRAP_ADMIN_EMAIL` | The account created at first launch, when there are no users. Does nothing afterwards. |
| `DATABASE_URL`, `AEOLUS_DB_SSL`, `AEOLUS_DB_CA_FILE` | Where Postgres is and how to talk TLS to it. See § Database. |
| `AEOLUS_S3_BUCKET`, `AWS_S3_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_FORCE_PATH_STYLE` | The object store. Empty the endpoint and supply a real key pair to use S3 itself instead of the bundled MinIO. |
| `AEOLUS_TRUST_PROXY` | Whose `x-forwarded-for` to believe. `uniquelocal` in the compose stack. See § Proxy and logging posture. |
| `AEOLUS_FRAME_ANCESTORS` | Who may frame Aeolus. Default `'self'`. |
| `AEOLUS_WS_URL` | Only when ws is on a different origin from api. Empty means the same origin at `/ws`. |
| `AEOLUS_COOKIE_DOMAIN` | Only when api and ws are split across hostnames; set it to the shared parent. |
| `AEOLUS_SANDBOX_MODE` | `audit` (default) or `enforce` for the compile sandbox. See § Compile pipeline. |
| `AEOLUS_TECTONIC_BUNDLE` | A TeX bundle you host, for pinning a version or running with no outbound network. |
| `ANTHROPIC_API_KEY`, `AEOLUS_AI_DAILY_CAP_CENTS` | Claude-assist, and its per-day spend ceiling in cents across the instance. Unset, the feature is absent. |
| `AEOLUS_MAIL_FROM` | Switches the mail adapter from the in-memory captor to SES. Unset, nothing is sent, which is right for an install with no mail server. |

### The images

Three Dockerfiles at the repo root, all built from the repo root as
context. Every `FROM` is pinned by digest; Tectonic and Typst are pinned
by SHA-256 and verified after download.

- `Dockerfile.api` is three stages: `web-build` compiles the SPA with
  the full dependency tree, `prod-deps` installs again with `--prod` so
  vitest, typescript, eslint, drizzle-kit and electron never reach the
  runtime image, and `runtime` carries the trimmed tree, the built SPA
  and the api source. It runs as an unprivileged `api` user and has a
  `HEALTHCHECK` against `/healthz`.
- `Dockerfile.ws` is two stages, a `--prod` install and a runtime, with
  no SPA to build.
- `Dockerfile.worker` has a dedicated `sandbox-build` stage so gcc and
  the kernel headers stay out of the runtime image, copies Node in from
  the same digest-pinned `node` image the other two run on rather than
  piping an unpinned nodesource script into bash as root — in the one
  image that runs untrusted documents — and pre-warms the Tectonic cache
  by compiling a document that exercises the packages a typical template
  pulls — inputenc, fontenc, geometry, graphicx, xcolor, hyperref,
  booktabs, fancyhdr, enumitem, titlesec, listings, amsmath, amssymb,
  amsthm, csquotes.
  The warm-up runs as the `compiler` user with the same
  `XDG_CACHE_HOME` the runtime container sees, because Tectonic splits
  its cache between `TECTONIC_CACHE_DIR` and `$XDG_CACHE_HOME/Tectonic`
  and a root-owned entry there defeats the whole exercise on the first
  real compile.

None of the three bakes in a hostname, a certificate authority bundle,
or a WebSocket URL. The same image runs on any hostname; everything
site-specific arrives as an environment variable at run time.

### Observability

All three processes log JSON lines to stdout and stderr, which is
whatever `docker compose logs` or the operator's log collector picks up.
`/healthz` on api and ws is unconditional liveness and is what the
containers' `HEALTHCHECK` uses; `/readyz` is the one that touches
dependencies — Postgres and the blob store on api, Postgres and the
`aeolus_room_evict` LISTEN client on ws. See § Process boot for both.
The worker has no HTTP surface at all: it is a queue consumer, and
whatever runs it just keeps the process alive.

There is no bundled metrics stack and no alerting. What to alarm on is a
property of where you run it, but the four signals worth wiring up
wherever that is: any of the three containers not running, `/readyz`
answering 503, `pgboss.job` depth climbing without draining, and
Postgres connection count against its maximum.

## Rollout plan (milestones)

| # | Milestone | Exit criteria |
| --- | --- | --- |
| M0 | Repo scaffolded, CI green on a hello-world | **Done** — `ci.yml` passes, README + ARCHITECTURE.md in place. |
| M1 | Auth | **Done** — a user signs in with an email and a passphrase, a session cookie is issued, integration tests pass. |
| M2 | Doc CRUD + Yjs collab | **Done** — two browsers converge; ACL enforced; snapshots compact. |
| M3 | Templates + fork | **Done** — admin creates template; user forks into a doc; cannot write back. |
| M4 | Compile pipeline (Tectonic + Typst) | **Done** — PDF appears in UI within 3s for a minimal doc. |
| M5 | Version history | Checkpoints, restore, history view. **Done** — `apps/api/src/routes/checkpoints.ts` implements CRUD + restore; `apps/web/src/components/HistoryPanel.tsx` provides the sidebar UI; integration + E2E tests pass the full create → edit → restore → diff-empty flow. |
| M6 | Claude-assist | **Done** — one instance-wide key (ADR 0005), proxy streams, quota enforced. |
| M7 | Electron build on all three OSes | **Done** — unsigned installers (ADR 0006) as Build Electron workflow artifacts. |
| M8 | Self-hostable in one command | **Done** — `docker compose up` on a machine with nothing but Docker gives a working instance, and `.github/workflows/docker.yml` proves it on every push by driving a first run through a real browser. |

Each milestone ends with (a) merged PR(s), (b) green CI, (c)
README/ARCHITECTURE update, (d) explicit integration tests in
`tests/integration` + `tests/e2e` referenced from `docs/TEST_PLAN.md`.

## Verification checklist

Walked through manually, on top of the automated tests:

- [ ] A fresh `docker compose up` prints an administrator passphrase
      once; signing in with it forces the setup screen, and the printed
      value stops working as soon as a new passphrase is chosen.
- [ ] An admin creates a second account, hands over the generated
      passphrase, and that user is likewise forced to replace it.
- [ ] Ten wrong passphrases lock an account for fifteen minutes; a
      wrong address and a wrong passphrase are indistinguishable in both
      response and timing.
- [ ] Sign-in works from Safari, Chrome and the Electron build.
- [ ] User creates a LaTeX doc from a template, edits it next to
      another user, both see live cursors, convergence is visually
      verified, then compiles to PDF in under 3s.
- [ ] Same exercise with a Typst template.
- [ ] User uploads a PNG, references it in the document, compile
      embeds it.
- [ ] User creates a checkpoint, edits destructively, restores, diff
      is empty.
- [ ] "Ask Claude" on a paragraph streams a response in and the
      suggestion can be accepted.
- [ ] Non-collaborator user cannot load the document via URL.
- [ ] Admin can open the same document despite not being in the ACL.
- [ ] Template is not modifiable by a non-admin.
- [ ] All integration + E2E tests green on `main` for 3 consecutive
      days under nightly cron.
- [ ] Secrets audit: no Anthropic key, cookie secret or database
      password baked into an image layer or committed to the repo.

## Sanity-check notes

Elements worth flagging after each redesign pass. Each has a
default resolution; revisit on the next major change.

1. **TLS is Caddy's job, and only in the shipped topology.** Set
   `AEOLUS_SITE_ADDRESS` to a hostname and Caddy obtains and renews a
   certificate itself. Behind a proxy of someone else's choosing, TLS
   termination, the certificate and the `x-forwarded-*` headers are all
   theirs — and `AEOLUS_TRUST_PROXY` has to name that proxy or the
   sign-in rate limit meters it instead of the caller.
2. **Tectonic package fetching.** Tectonic pulls missing LaTeX
   packages on demand from its bundle host. Resolution: pre-warm the
   package cache into the worker image for the packages a typical
   template uses, so day-one cold compiles do not all pay for the
   download; a compile needing an uncached package fetches it at runtime
   (ADR 0011 chose this over shipping a full offline bundle). Adding a
   package to the warm set: `docs/RUNBOOKS/add-latex-package.md`.
   Pinning a bundle, or running with no outbound network at all:
   `AEOLUS_TECTONIC_BUNDLE`, and
   `docs/RUNBOOKS/tectonic-bundle.md`. Note the worker is **not**
   network-isolated today; `--network=none` is neither a container
   setting nor a Tectonic `-X compile` flag here. Filesystem confinement
   of the engine is ADR 0022 (Landlock); network isolation is tracked
   separately.
3. **Typst CodeMirror grammar maturity.** The Typst CM6 ecosystem
   is younger than LaTeX's. Resolution: start with the community
   `codemirror-lang-typst` package if stable, else wrap a Lezer
   grammar around the official Typst tree-sitter.
4. **Electron auto-update is dormant.** `electron-updater` is wired but
   reads no feed: `publish: null`, and the feed URL is set only when a
   packaged build carries `AEOLUS_UPDATES_HOST`, which no build sets
   (ADR 0006). Signed updates become possible once code-signing certs
   exist, via Electron's built-in signature verification.
5. **The sandbox ships in `audit`, which confines nothing.** That is
   deliberate — `enforce` fails closed on a host without Landlock, and a
   new install that cannot compile is worse than one that logs what it
   would have blocked. It does mean an operator who never reads the
   boot line is running the TeX engine unconfined. See § Compile
   pipeline.
6. **WebSocket scaling.** With a single `ws` container, all Yjs traffic
   goes through one process, which is the right shape for a team. To
   scale out, the y-websocket sticky-session contract requires either
   session affinity at the proxy on the per-user cookie or a fan-out
   adapter — defer until needed.
7. **pg-boss vs BullMQ.** An earlier design used BullMQ-on-Redis;
   pg-boss-on-Postgres replaced it so the stack is two stateful
   services rather than three. At a team's traffic pg-boss is
   comfortable. Revisit if compile concurrency or queue depth grows past
   Postgres's ergonomic ceiling.
8. **Turborepo**: kept for local dev ergonomics; remote cache
   not enabled.

## Risks & mitigations

- **Postgres is load-bearing for sessions, queue and pub-sub.** Watch
  `pg_stat_activity`, `pgboss.job` depth and the LISTEN backlog, and
  alarm on connection saturation. Both `db.t*`-class hardware and a
  laptop are fine at a team's traffic; the failure mode to plan for is
  connection exhaustion, not throughput.
- **Document state spans Postgres and object storage — neither alone is
  a backup.** Compaction snapshots cover up to the last 200 ops or five
  minutes of idle; the live update tail between snapshots lives only in
  `doc_updates`. A restore from the bucket alone loses that tail; a
  restore from Postgres alone loses the snapshot the pointer refers to.
  Take both, close together. See § Backups and recovery, and note that
  the per-snapshot sidecar manifests make a rebuild from the bucket
  alone possible when there is no other choice.
- **Tectonic cache cold starts are slow.** Mitigated by the pre-warm in
  `Dockerfile.worker` and the `tectonic-cache` volume in
  `docker-compose.yml`. Remove the volume and the first compile after
  every `docker compose up` pays for the bundle download again.
- **The Anthropic key is an instance-wide credential.** It is read from
  the environment, never logged, never written into an image layer, and
  the feature is absent without it. `AEOLUS_AI_DAILY_CAP_CENTS` bounds
  what a leak or a runaway client can spend in a day.
- **`AEOLUS_COOKIE_SECRET` is a signing key.** Anyone who knows it can
  mint a session for any account. Treat it as a private key; changing it
  signs everybody out, which is also how every session is revoked at
  once.

## Process boot, configuration, readiness and shutdown (ADR 0024)

The three launchers (`apps/api/src/bin/server.ts`, `apps/ws/src/bin/server.ts`,
`apps/compile-worker/src/bin/worker.ts`) share one contract since
2026-09-13:

- **Required configuration fails the boot in production.**
  `requireEnv(name, devDefault?)` in `packages/db/src/env.ts` throws
  `MissingEnvError` when `NODE_ENV=production` and the variable is
  unset; the dev default applies everywhere else. api and ws require
  `DATABASE_URL` and `AEOLUS_COOKIE_SECRET`; the worker requires
  `DATABASE_URL` and `AEOLUS_S3_BUCKET`. `blobStoreFromEnv()` in
  `@aeolus/crdt` builds the S3 client from `AEOLUS_S3_BUCKET` /
  `AWS_REGION` / `AWS_S3_ENDPOINT` / `AWS_S3_FORCE_PATH_STYLE` and refuses
  an in-memory store in production — an in-memory blob store loses every
  upload on restart. `poolSslFor` refuses to guess in production when
  the host is not plainly local, no CA bundle is present and
  `AEOLUS_DB_SSL` is unset, and warns once (password redacted)
  elsewhere; before this it silently connected with
  `rejectUnauthorized: false`. Every Dockerfile sets
  `NODE_ENV=production`, so these apply to every container. The full
  per-process variable tables are in README.md § Configuration.
- **Migrations run at boot**, from api and from ws, before either opens
  its pool. `runMigrations` takes a `pg_advisory_lock`, so concurrent
  boots serialise, and `public.__drizzle_migrations` makes each call
  idempotent.
- **Logging.** api: Fastify's pino, on by default in production
  (`AEOLUS_LOG` unset → default; `1`/`0` forces). The launcher used to pass
  `AEOLUS_LOG === '1'`, a boolean, which defeated that default and left
  production error logging off — the comment claiming otherwise was
  wrong from the day it was written. Request ids are an inbound
  `x-request-id` when present, a `randomUUID()` otherwise. ws: a pino
  logger (`apps/ws/src/log.ts`, level `AEOLUS_LOG_LEVEL`) carried into
  each room, so `persistUpdateBatch` failures, backpressure closes,
  upgrade errors and LISTEN-client errors are JSON lines with
  `yjsDocId` / `docId` / `seq` fields. Idle-pool client errors from
  `packages/db` route through the same logger where one exists and a
  JSON line on stderr otherwise. Everything goes to stdout and stderr;
  there is no log shipper in the stack.
- **Readiness.** `/healthz` stays unconditional and is what the
  container health check probes — never point a health check at
  `/readyz`, or a transient database blip takes the whole service out.
  `/readyz` on api runs `select 1` and round-trips one probe object
  (`_readyz/api-<pid>`, written once per process; a real object rather
  than a bucket-level call, because an object-scoped credential answers
  403 rather than a clean miss for a key that does not exist); on ws it
  checks the pool and the `aeolus_room_evict` LISTEN client. Both probes
  are bounded at 2 s, the result is cached 30 s, and the body is
  `{ ok, checks, checkedAt }` with 200 or 503.
- **Shutdown.** Signal handlers are `once` — a second signal during the
  drain must not start a second shutdown, and a second `pool.end()`.
  Each launcher arms a deadline (api/ws 25 s, worker 28 s) and exits 1
  on its own if the drain has not finished, which is better than being
  killed silently by whatever runs the container. The worker's `close()`
  waits for in-flight compiles (`drainTimeoutMs`, default 25 s) after
  `offWork`; before, `process.exit` killed running engines and their
  `compile_results` rows stayed `running` forever. api awaits
  `boss.stop({ graceful: true, wait: true })` before ending the pool.
- **Removed.** The worker's `pg_notify('aeolus_compile_events', …)` on
  every state change — nothing had subscribed since the UI moved to
  polling — and `apps/ws`'s dependency on `@aeolus/compile-worker`, which
  imported nothing. Non-engine compile failures (storage, database)
  reach the author as `INTERNAL_COMPILE_FAILURE`; the cause is logged by
  the worker.
