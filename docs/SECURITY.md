# Security

## Threat model

Aeolus is software you run. Most of the perimeter is yours, not the
application's, so this section says what the application does and does not
defend against — and what you have to do yourself.

**The starting assumption is that the app is reachable.** A previous life of
this codebase sat behind a private overlay network where nothing on the
internet could reach it. Nothing here assumes that any more. If you put Aeolus
on the internet, everything below is what stands between it and the internet.

### Somebody trying to get in

Sign-in is an email and a passphrase this instance checks itself. What holds:

- The policy asks for length, not composition — at least sixteen characters and
  either four or more words or a single string of twenty-four — because that is
  what actually resists guessing. A denylist catches the obvious phrases that
  clear the length rule anyway (`correcthorsebatterystaple`, keyboard walks, a
  word repeated four times).
- Ten failures lock an account for fifteen minutes.
- Sign-in is rate limited per IP address, 30 a minute. **Behind a reverse proxy
  this only works if `AEOLUS_TRUST_PROXY` names the proxy**; unset, every
  request looks like it came from the proxy and the limit is one bucket for
  everyone. The account lockout is the layer that does not depend on getting
  that right.
- A wrong passphrase and an address with no account are indistinguishable, in
  the response body and in the time it takes — the unknown-address path verifies
  against a fixed decoy hash so it costs the same scrypt work.
- Storage is scrypt with `N=2^15, r=8, p=1`, a 16-byte per-hash salt, and the
  parameters recorded beside each hash so they can be raised later. Verification
  is `timingSafeEqual`. See `packages/auth/src/passphrase.ts`.

What does not hold: there is no second factor. A passphrase is the whole
credential. If that is not enough for what you are storing, put an
authenticating proxy in front.

### Somebody who is already in

- **A stolen session.** The cookie is `httpOnly`, `SameSite=Strict` and signed;
  the value in the database is a SHA-256 hash of it, so a database dump cannot
  be replayed. It rotates on every authenticated request. Changing
  `AEOLUS_COOKIE_SECRET` invalidates every session at once, which is the blunt
  instrument if you need one.
- **A stolen API token.** A `/api/v1` bearer token acts as the user who minted
  it, so a leaked write-scope token can do anything that user can, including
  deleting their documents. Tokens are read-scope by default; only a SHA-256
  hash is stored, so the plaintext exists once and nobody — operator included —
  can recover it; every signed-in user can see and revoke every token;
  `last_used_at` makes staleness checkable. A token dies with its owner: the
  auth hook re-checks `disabled_at` on every request and the row is
  `ON DELETE CASCADE`.
- **A compromised administrator.** An administrator can read any document,
  change any template, and issue anybody a new passphrase. Every one of those
  actions is in the audit log. Keep the number of administrators small; that is
  the whole control.

### A malicious document

**This is the sharp edge, and it is worth reading properly.** A LaTeX document
is a program. `\input{/etc/passwd}` is valid LaTeX, and Tectonic has no path
sandbox of its own. Anybody who can create a document in your instance can ask
the compile worker to read a file.

What stands in the way:

- The engine runs as an unprivileged user inside the worker container.
- `aeolus-sandbox`, a small Landlock helper (`apps/compile-worker/native/`),
  confines it to the per-compile working directory and the Tectonic cache,
  denying `/proc`, `/etc`, the worker's own files and every other path.
- `TECTONIC_UNTRUSTED_MODE=1` disables shell-escape.
- Typst additionally sandboxes file reads to the project root by itself.
- CPU, filesystem and a hard compile timeout bound how long any of it runs.

**The sandbox defaults to `audit`, which logs and blocks nothing.** It has to,
because `enforce` fails closed and would break every compile on a host whose
kernel or container runtime does not expose Landlock. Set
`AEOLUS_SANDBOX_MODE=enforce` once the worker's boot line tells you the host
supports it. Until you do, the container boundary and the unprivileged user are
the only things between a document and the worker's filesystem.

**The worker has outbound network access.** Tectonic fetches its TeX bundle over
the network on first use, so the container is not network-isolated. Removing
that — by pinning a bundle with `AEOLUS_TECTONIC_BUNDLE` and denying egress — is
a hardening step available to you, not a shipped default.

### Somebody watching the network

- Set `AEOLUS_SITE_ADDRESS` to a real hostname and Caddy gets a TLS certificate
  and redirects http to https. Then set `AEOLUS_COOKIE_SECURE=1` so the session
  cookie is never sent in the clear. Without both, everything is plaintext,
  including the passphrase at sign-in.
- Database TLS is decided by `AEOLUS_DB_SSL`. The bundled Postgres is on a
  private Docker network with no published port and uses `disable`. A database
  reached across a network should be `verify`, with `AEOLUS_DB_CA_FILE` pointing
  at your provider's CA bundle. `require` encrypts without checking who
  answered, which stops a passive listener and not an active one.

### The database itself

Give the application's database role `CREATE` on `public` and nothing more. It
owns the application's tables and cannot create schemas, install extensions or
grant privileges, so a compromised process is bounded to the data its tables
already reach. The migration runner is built to work inside that constraint
(ADR 0010).

## Passphrase authentication

There is no identity provider. Aeolus stores a passphrase hash and checks it
itself, which is the only design that works for an install with no directory,
no mail server and no outbound network.

The implementation is in three files, and they divide cleanly: the policy and
the hashing in `packages/auth/src/passphrase.ts`, everything that touches
`users.passphrase_hash` in `apps/api/src/services/credentials.ts`, and the
routes that turn its errors into status codes in `apps/api/src/routes/auth.ts`.

### The policy

At least sixteen characters, and either four or more whitespace-separated words
or a single string of twenty-four. No character-class rules and no expiry —
those produce `P@ssw0rd!` and a sticky note. This is the shape
[NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html) has
recommended since 2017.

Also rejected: a bundled denylist of well-known phrases that clear the length
rule; a repeated unit however long (`abcabcabcabc`); a run of eight or more
characters off one keyboard row; four words that are the same word; anything
built from the account's own email address or display name; anything containing
the application's name; leading or trailing whitespace, which is refused rather
than trimmed so the stored credential is what was typed.

Every reason is returned at once, in the `problems` array of the 422, so the
screen can list them all rather than making someone guess one at a time.

`GET /api/auth/policy` returns the rule as a sentence and a generated
suggestion, so the UI cannot promise something the server does not enforce.

### Storage

scrypt from `node:crypto`: `N=2^15, r=8, p=1`, a 64-byte key, a 16-byte random
salt per hash, stored as `scrypt$N$r$p$salt$hash` in base64url.

Argon2id would be the better modern choice. Every Node binding for it is a
native module, and a native module is a build that can fail on somebody's
architecture — which, for software people install themselves, is a worse
failure than the one it prevents. scrypt is memory-hard, in the standard
library, and present everywhere.

The parameters travel with each hash, so they can be raised later without
invalidating anyone's credential: `needsRehash` notices an older record and
`authenticate` upgrades it in place the next time its owner signs in.
Verification refuses absurd parameters rather than letting a poisoned row
allocate a gigabyte, and returns false rather than throwing on a malformed
record, so a corrupt row is not a 500 and is not distinguishable from a wrong
passphrase.

### Generated credentials and forced setup

Three things hand out a passphrase nobody chose: the first launch of an empty
instance, an administrator creating an account, and an administrator resetting
one. All three produce six words from the EFF short wordlist — about 62 bits —
show it exactly once, and flag the account `must_set_passphrase`.

While that flag is set, `requireUser` answers `403 passphrase_setup_required`
to everything except the handful of routes the setup screen needs
(`/api/auth/passphrase`, `/api/auth/policy`, `/api/auth/login`, `/api/me`,
`/api/me/session`). `requireAdmin` refuses too, and `/api/v1` refuses a bearer
token minted by such a user — a token belongs to its minting user, so somebody
who has not chosen their own passphrase cannot act through one either.

Setting a passphrase does not require the current one while that flag is set:
the sign-in that got there just proved it. Once it is clear, changing it does.

### Recovery

An administrator issues a new passphrase from **Admin → Users**. It is shown
once, the account is flagged for setup again, and **every session the target
holds is deleted in the same transaction** — a reset that left them signed in
would not recover an account somebody else is already inside.

There is no emailed reset link. That needs a mail server, which a self-hosted
install may not have, and a recovery path that silently does not work is worse
than none.

### Session cookie

- **Name**: `aeolus_session`.
- **Attributes**: `httpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` when
  `AEOLUS_COOKIE_SECURE` is on — which it must be behind https, and is off by
  default so a plain-http install can sign anybody in at all. Signed with
  `AEOLUS_COOKIE_SECRET`.
- **TTLs**: 12 hour idle, 30 day absolute. The token is **rotated on
  every authenticated request** via the session store's `touch()`; the
  old row's idle marker is rewound so it falls out of the read window in
  10 seconds. A client that ignores `Set-Cookie` therefore gets exactly
  one request per token, which is why the cookie is not usable as a
  machine credential.
- **Storage**: server-side state in the `sessions` Postgres table, keyed
  by a SHA-256 hash of the cookie value, so a database dump cannot be
  replayed as a session token.
- **Rotation opt-out**: `sessions.disable_rotation` exists for
  long-lived non-browser sessions minted by
  `POST /api/admin/bot-session`. It predates the API token plane and is
  a debugging aid, not a supported machine credential.

### `SameSite=Strict` is the CSRF control

Aeolus registers no CSRF token and no `@fastify/cors`. On the browser
plane the protection is that `aeolus_session` is `SameSite=Strict`, so a
cross-site request never carries it, and with no CORS headers a
cross-origin page cannot read any response either. That one attribute is
doing all of the work — worth knowing before it is ever relaxed to
`Lax`.

`POST /api/tokens` is the one cookie-authenticated route whose effect is
a durable credential, so it carries a second, cheap check: a request
whose `sec-fetch-site` header is present and not `same-origin` is
refused. A missing header is allowed through — non-browser clients do
not send it, and the cookie attribute remains the real control.

**On `/api/v1` CSRF is structurally impossible**, not merely mitigated:
the plane accepts only `Authorization: Bearer`, and a browser never
attaches that header on its own.

Sign-out is `DELETE /api/me/session`, which no `<img>` or `<form>` can
issue.

### Response headers and the CSP (ADR 0025)

Every api response carries, via `@fastify/helmet`:
`X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`Cross-Origin-Opener-Policy: same-origin-allow-popups` (the PDF preview opens
in a new tab and reaches back through `window.opener`),
`Cross-Origin-Resource-Policy: same-origin`, and `Strict-Transport-Security`
when cookies are `Secure`. `X-Frame-Options` is deliberately never sent — it
has no allow-list, so a stray `SAMEORIGIN` would override whatever
`AEOLUS_FRAME_ANCESTORS` permits.

Two CSP headers go out. `Content-Security-Policy` carries the enforced
`frame-ancestors` list, which is `'self'` unless `AEOLUS_FRAME_ANCESTORS` says
otherwise — nothing may frame Aeolus but Aeolus.
`Content-Security-Policy-Report-Only` carries the full candidate policy
(`default-src 'self'`, inline styles for CodeMirror, `blob:` workers for
pdf.js, `connect-src` for this origin plus whatever `AEOLUS_WS_URL` names) and
reports violations to `POST /api/csp-report`, which logs the directive, the
blocked URI and the document at warn level. It is report-only because the
end-to-end suite drives the SPA from the Vite dev server and so cannot prove
an enforced policy; enforce it once your own instance has produced no reports
for a while.

### Rate limits on the browser plane

Four cookie-plane routes carry per-IP budgets (`middleware/rate-limits.ts`):
`POST /api/ai/assist` 30/min, `GET /api/auth/login` 20/min,
`POST /api/tokens` 30/min, `POST /api/ws/ticket` 60/min. Over budget answers
`429 { error: "rate_limited" }` with `retry-after`, the same envelope as
`/api/v1`'s 120/min. Everything else on the plane is unmetered by design:
it is cookie-gated and behind the overlay.

### API tokens (`/api/v1`)

Full rationale in [`docs/DECISIONS/0020`](DECISIONS/0020-self-service-api-tokens.md).

- **Format**: `aeolus_<16 hex>_<43 char base64url>`. The id half is
  public and is the `api_tokens` primary key, so verification is one
  indexed lookup plus a constant-time compare rather than a scan over
  every live token. The literal `aeolus_` prefix is what secret scanners
  key off, and makes a token pasted into a ticket recognisable by
  whoever should revoke it.
- **Entropy**: 32 random bytes in the secret half. Stored as
  `sha256(whole token)`, hex — a plain SHA-256 rather than a KDF is
  correct here precisely because the input is uniform randomness, not a
  human-chosen password.
- **Shown once**, at creation, and stored nowhere else. Lose it and you
  revoke and mint another.
- **Scope** is `read` or `write`, fixed at mint, enforced **by HTTP
  method** rather than a route list — so a write route added later is
  covered the day it ships, and forgetting to classify one denies a read
  token rather than over-permitting it. An unrecognised or absent scope
  resolves to read-only: the gate fails closed, and a test proves it by
  writing `'superuser'` into the column.
- **Scope is not the ACL.** A token also carries its minting user's
  document permissions, and both gates apply. A write-scope token minted
  by a viewer still gets 403; one minted by a non-collaborator gets 404,
  per ADR 0003.
- **Revocation** is deleting the row — the hash *is* the credential, so
  "revoked" has only one meaning. Effective on the next request. Every
  signed-in user can revoke every token, deliberately: a token writes to
  shared documents, so a revoke must never wait on one person being
  reachable.
- **Minting is browser-plane only** (`POST /api/tokens`, session-gated),
  so a token cannot mint a successor and outlive its own revocation.
- **A ws ticket is the one credential this plane hands out that it
  cannot then police.** `POST /api/v1/ws/ticket` returns a five-minute,
  document-bound ticket for the Yjs socket; once redeemed the caller is
  outside the plane, where there is no scope gate, no rate limit, and no
  per-edit audit. Minting one therefore requires a **write-scope** token
  even though the ticket grants nothing the document ACL does not already
  allow — a read-scope token must not reach a channel that cannot enforce
  its scope. Every mint is audited as `ws.ticket.mint`. The room's own ACL
  still applies on the socket.
- **Claude-assist spend is bounded by the minting user's quota**, not by
  a separate machine budget, because a token acts as its creator: an
  automated call draws down the same hourly, daily and token allowances
  that person spends in the editor, and the global daily spend cap sits
  above both. This is a property of the token design rather than a
  control that had to be added.
- **A database outage answers `503 token_store_unavailable`**, not 401:
  a client that reads a transient 401 as "revoked" throws away a good
  credential.

## Secrets handling

- **Runtime.** Everything comes from the environment. `.env` is read by
  `docker compose`; nothing in the repository contains a credential, and
  `.gitignore` keeps `.env` out of git. If you have a secret manager, inject
  the values from it instead — the application does not care where they came
  from.
- **`AEOLUS_COOKIE_SECRET` is the important one.** Anyone holding it can mint a
  session for any account. There is no default, on purpose: a shipped default
  would be a secret every install shared. Generate it with
  `openssl rand -base64 48`.
- **Logging.** Emails are redacted in log lines, and session tokens, passphrase
  bytes and AI prompts and completions are never logged at all. Only token
  counts and cost totals.
- **What ends up in the database.** Passphrases as scrypt hashes; sessions and
  API tokens as SHA-256 hashes of the credential. A database dump contains
  nothing replayable as a session or a token, and nothing reversible to a
  passphrase.

## Third-party licences

Fonts and wordlists redistributed in this repository carry their own terms, all
of them free: Jost and JetBrains Mono under the SIL Open Font License 1.1, the
EFF short wordlist under CC BY 3.0 US. See `third_party/NOTICE.md`.

## Dependency hygiene

- **Dependabot is on** (`.github/dependabot.yml`): security updates as
  advisories land, grouped minor and patch bumps weekly, majors on their own,
  Electron majors held back.
- **`pnpm audit` is expected to be clean**, with two accepted residuals,
  neither of which reaches a shipped image or a running service:
  - `extract-zip <= 2.0.1` (symlink path traversal during archive extraction),
    reached only by Electron's own installer at `pnpm install` time on a
    developer machine. No patched release exists.
  - `esbuild` build-time advisories via `tsx` and `drizzle-kit`. Both are
    development tools and neither is ever served. **Do not override esbuild
    globally**: Vite pins `^0.25`, and a forced newer version makes it reject
    every transform.
- **Transitive floors** that no direct bump reaches are pinned in
  `pnpm.overrides` in the root `package.json`.
- **Container images.** Every base image in the three Dockerfiles is pinned by
  digest, and Tectonic and Typst by SHA-256. Rebuild periodically: a pinned
  digest is reproducible, which also means it does not pick up OS security
  updates by itself.

## Reporting a vulnerability

See `SECURITY.md` at the root of the repository. Do not open a public issue.
