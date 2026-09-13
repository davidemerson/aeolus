# 0027 — One origin in front of everything, and a shared blob store that is not optional

- **Status**: accepted
- **Date**: 2026-09-13
- **Deciders**: David Emerson
- **Supersedes/relates**: amends [`0001`](0001-scope.md)'s Hosting and
  Ingress rows; [`0004`](0004-e2e-testcontainers-over-compose.md) (why
  the test suite does not use this stack, and what that costs);
  [`0024`](0024-fail-fast-env-and-readiness.md) (the variables these
  services set)

## Context

Aeolus is three server processes — `api` (REST plus the SPA shell), `ws`
(one collaborative editing session per open document) and `worker`
(Tectonic and Typst) — over Postgres and an S3-compatible blob store.
Publishing it means deciding how those pieces are arranged by default,
because whatever `docker-compose.yml` says is what almost every install
will run.

Two of the arrangement choices are not preferences. Getting either wrong
produces an application that **starts, looks correct, and loses data**,
with nothing in any log. They are written down here because a future
change that looks like a simplification would reintroduce both.

## Decision

### One origin, with Caddy in front

Six services, one published port:

```
caddy    the only published port; /ws → ws, everything else → api
api      the REST API and the single-page app
ws       the collaborative editing session for each open document
worker   Tectonic and Typst; compiles are queued, not synchronous
postgres documents, users, sessions, the job queue
minio    object storage for document snapshots and uploaded assets
```

`Caddyfile` is four meaningful lines: `handle_path /ws*` reverse-proxies
to `ws:8080` (stripping the prefix, so ws sees the paths it expects) and
`handle` sends everything else to `api:8080`. The database and MinIO
publish nothing and are unreachable from the host.

**The reason is the session cookie.** The browser gets `aeolus_session`
from one host. A WebSocket upgrade to a *different* host does not carry
it — the upgrade is a plain HTTP request subject to ordinary cookie
scoping, and nothing about it prompts the browser to attach a cookie
scoped elsewhere. The ws process then sees an unauthenticated upgrade.

What that looks like from the outside is the problem: the editor
connects, the document renders, the cursor moves, characters appear on
screen — and every keystroke is dropped, because the connection was
never authorised to join the room. There is no error banner, no failed
request in the network panel, and no 500 anywhere. The author finds out
when they reload.

Two hostnames can be made to work: set `AEOLUS_COOKIE_DOMAIN` to the
shared parent so the cookie is sent to both, and set `AEOLUS_WS_URL` so
the SPA dials the right place and the CSP's `connect-src` knows about it
([`0025`](0025-browser-plane-edge-hardening.md)). Both variables exist
and are documented in `.env.example` for exactly that case. But it is
two more things to get right for no benefit, and the failure mode when
you get them wrong is silent data loss. One origin has nothing to
configure.

Everything else about the topology falls out of that choice:

- `AEOLUS_WS_URL` is unset in the compose stack, so the SPA's socket URL
  is this host with a `/ws` prefix.
- `AEOLUS_COOKIE_DOMAIN` is unset, so the cookie is host-only, which is
  the tighter scope and is sufficient.
- `AEOLUS_TRUST_PROXY: uniquelocal` — Caddy sets `X-Forwarded-For`
  itself, appending the immediate peer rather than trusting what
  arrived, and it is on the compose network, so its address is the one
  hop worth believing. Without this every caller looks like Caddy and
  the sign-in rate limit is one bucket for everybody
  ([`0025`](0025-browser-plane-edge-hardening.md)).
- `AEOLUS_WS_INTERNAL_URL: http://ws:8080` — how the admin diagnostics
  page reaches ws over the private network rather than back out through
  the proxy.
- HTTPS is one setting. Put a hostname in `AEOLUS_SITE_ADDRESS`, publish
  80 and 443 instead of 8080, and Caddy obtains and renews a certificate
  on its own. Then set `AEOLUS_COOKIE_SECURE=1`, which is also what
  turns HSTS on.

### MinIO is a service, not a suggestion

`blobStoreFromEnv()` returns a `MemoryBlobStore` when `AEOLUS_S3_BUCKET`
is unset. Per process. That is correct for a test — the E2E suite runs
all three services in one process and shares one instance
([`0004`](0004-e2e-testcontainers-over-compose.md)) — and it is
catastrophic across containers, because Yjs persistence is split between
Postgres and the blob store:

1. `snapshotDoc` (`packages/crdt/src/persist.ts`) encodes the document
   state, **puts it in the blob store**, upserts the `doc_snapshots` row
   pointing at that key, and then **deletes every `doc_updates` row at
   or below the snapshotted sequence**. The updates are gone on purpose:
   the snapshot subsumes them.
2. `loadDoc` reads the `doc_snapshots` row, fetches `snap.key` from the
   blob store, applies it, and then replays the surviving updates on
   top.
3. If `blobs.get(snap.key)` returns null, `loadDoc` **carries on**. It
   applies no snapshot and replays only the updates that survived the
   prune.

With a per-process in-memory store, step 1 happens in one container and
step 2 in another, so step 3 is the normal case: the api writes a
snapshot and prunes the updates it subsumes, and the ws process then
loads a document that has lost everything before the snapshot. The
document comes back truncated. Nothing throws — a missing blob is
indistinguishable from a document that never had a snapshot — so nothing
is logged, and the truncation is the first sign.

So the stack ships MinIO, `AEOLUS_S3_BUCKET` is set for all three
services, and `.env.example` says "This is not optional" beside it.
`blobStoreFromEnv` also refuses the in-memory store outright when
`NODE_ENV=production` ([`0024`](0024-fail-fast-env-and-readiness.md)),
which every image sets — so the misconfiguration cannot reach a running
container by accident; it can only be reached by an operator who removes
the variable and the guard.

Pointing at real S3 or any S3-compatible service instead is supported
and is a three-line change: clear `AWS_S3_ENDPOINT`, set `AWS_REGION`,
and supply a credential pair. Two details that are otherwise a
half-hour each:

- `AWS_S3_FORCE_PATH_STYLE: '1'` for MinIO, which does not do
  virtual-host-style bucket addressing.
- The credential pair is required **even against MinIO**. With no
  credentials at all the AWS SDK goes looking for instance metadata and
  hangs for about a minute before failing, which reads as "the app is
  broken", not "the app has no key".

A separate one-shot `minio-init` service creates the bucket with `mc mb
--ignore-existing` and exits; the three app services wait on it
completing. The application does not create buckets, because doing so
needs a credential far broader than reading and writing objects, and the
narrow credential is the one worth handing to a process that runs
attacker-controlled LaTeX
([`0022`](0022-sandbox-compile-engine-with-landlock.md)).

## Consequences

- The default install is `cp .env.example .env`, set
  `AEOLUS_COOKIE_SECRET`, `docker compose up -d`. Nothing else is
  required, and the app is at `http://localhost:8080`.
- Caddy is a mandatory component rather than a convenience. Anyone
  replacing it with their own proxy has to preserve the two properties
  that matter: one origin for the browser, and a trustworthy
  `X-Forwarded-For`.
- Six containers is more than a single-process deployment would need.
  That is the price of a compile worker that can be sandboxed, resource
  limited and restarted independently of the editor.
- The comments in `docker-compose.yml`, the `Caddyfile` and
  `.env.example` restate the two failure modes above at the point where
  someone would cause them. They are duplication on purpose: an operator
  editing a compose file is not reading `docs/DECISIONS/`.

## Alternatives considered

- **Two hostnames, one for the app and one for the socket.** Rejected as
  the default. It works with `AEOLUS_COOKIE_DOMAIN` and `AEOLUS_WS_URL`
  set correctly, and it fails silently when they are not.
- **No reverse proxy; publish api and ws on two ports.** Same cookie
  problem, arrived at faster — an origin is scheme plus host plus
  **port**, so `localhost:8080` and `localhost:8081` are two origins.
- **Make MinIO optional for a "quick try".** Rejected. The install that
  would take that option is exactly the one that will not recognise a
  truncated document as a configuration error, and there is nowhere to
  put a warning that gets read before the data is gone.
- **One container running all three processes**, so the in-memory store
  would be shared. Rejected: it makes the worker's sandbox and resource
  limits impossible to apply separately, gives every crash the whole
  application's blast radius, and would still be wrong the moment
  anybody scaled a process to two.
