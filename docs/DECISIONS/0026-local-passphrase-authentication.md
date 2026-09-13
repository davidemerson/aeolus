# 0026 — Authenticate locally with an email and a passphrase

- **Status**: accepted
- **Date**: 2026-09-13
- **Deciders**: David Emerson
- **Supersedes/relates**: supersedes the invitation flow in
  [`0016`](0016-invite-management-rotate-on-copy.md); amends
  [`0001`](0001-scope.md)'s Auth row; the sign-in rate limit is
  [`0025`](0025-browser-plane-edge-hardening.md)'s, and the machine
  credential that is *not* this is [`0020`](0020-self-service-api-tokens.md)

## Context

Aeolus previously authenticated against an external identity provider:
the app held no credential, ran no sign-in form, and every account came
from a directory somebody else operated. That is a good arrangement when
the directory already exists. It is an impossible one for a project
whose whole premise is that you clone it and run it.

An identity provider is not a dependency a self-hosted document editor
can require. Setting one up is more work than running Aeolus, it costs
money at most providers, and it means an application that cannot be
evaluated at all until the operator has done that work. `docker compose
up` has to end with somebody able to sign in.

The other end of the problem is mail. Any credential scheme that leans
on "we'll email you a link" needs an SMTP relay or a mail API, a sender
domain, SPF and DKIM records, and somewhere for bounces to go. A
self-hosted install has none of that by default, and a password-reset
flow that silently does nothing is worse than not having one.

So: the credential is local, and nothing in the sign-in path may assume
outbound mail works.

## Decision

**Email plus a passphrase, verified against a scrypt hash in the
`users` table.** The policy lives in one place,
`packages/auth/src/passphrase.ts`; everything that touches
`users.passphrase_hash` lives in
`apps/api/src/services/credentials.ts`; the routes in
`apps/api/src/routes/auth.ts` only turn those errors into status codes.

### A passphrase, not a password

The policy asks for **length and word count and nothing else**:

- at least 16 characters, and
- four or more words, **or** a single string of 24 or more characters
  (`PASSPHRASE_LONG_ENOUGH`) — so a long random string from a password
  manager passes without being made to look wordy.

No character classes, no expiry, no hints, no security questions. That
is the shape NIST SP 800-63B has recommended since 2017, and the reason
is that composition rules do not produce entropy — they produce
`P@ssw0rd!` and a sticky note. Length does produce entropy, and a
sentence is something a person can actually remember.

What the policy *does* check, because length alone is gameable at these
lengths:

- a **denylist** of about twenty phrases that already pass the length
  rule — `correcthorsebatterystaple`, `passwordpassword`,
  `qwertyuiopasdfgh`, `thisisapassphrase`. `password` is caught by
  length; `passwordpassword` is not, which is the whole point.
- **repeated units** — `abcabcabcabc` and `aaaaaaaaaaaaaaaa` carry a few
  bits however long they are.
- **keyboard runs** of eight or more characters off one row, forwards or
  backwards.
- **four words that are the same word** — "north north north north" is
  four words and about ten bits.
- the candidate containing the **mailbox half of their own email**,
  **their own name**, or the string **`aeolus`**.

`checkPassphrase` has no side effects and returns every problem as a
sentence, in the order to show them. `GET /api/auth/policy` returns
`PASSPHRASE_RULE` — the single sentence the setup screen prints — and a
generated suggestion, so the server that enforces the rule is also the
one that states it and the two cannot drift.

### scrypt, not Argon2id

Argon2id is the better algorithm and it is not the right choice here.

Every Argon2 binding for Node is a native module. A native module is a
compile step in the install path, and a compile step is a thing that
fails: on an architecture nobody tested, on a distribution without a
toolchain, on the next Node ABI bump, in a slim base image, on someone's
Raspberry Pi. For a project whose success condition is that a stranger
can `docker compose up`, a dependency that can fail to build is a worse
risk than the gap between scrypt and Argon2id — which is real, but is a
gap between two memory-hard functions, not between a good one and a bad
one.

`node:crypto`'s scrypt is memory-hard, in the standard library, and
present on every platform Node runs on. The parameters are N = 2^15,
r = 8, p = 1, a 64-byte key and a 16-byte random salt: about 64 MB of
memory per hash.

The stored form is `scrypt$N$r$p$salt$hash`, all base64url — **the
parameters travel with the hash**. `verifyPassphrase` reads N, r and p
out of the record rather than assuming today's constants, so raising
them later does not invalidate anyone's credential; `needsRehash`
reports a record made with weaker ones and `authenticate` transparently
re-hashes on the next successful sign-in.

Two details in `verifyPassphrase` that are deliberate:

- it **returns false rather than throwing** on a malformed record. A
  corrupt row must not be a 500 on the login route, and must not be
  distinguishable from a wrong passphrase.
- it **refuses absurd parameters** (N outside 1024…2^20, r outside
  1…32, p outside 1…16) before allocating, so a poisoned row cannot ask
  for a gigabyte of heap.

Inputs are NFKC-normalised on both hash and verify, so a passphrase
typed on a different keyboard still matches.

### Every account starts on a credential it must replace

There is no self-registration. An account is created either by the
first-launch bootstrap or by an administrator, and in both cases it
starts with a **generated** passphrase — six words from the EFF short
wordlist (1296 words, so about 62 bits) via `randomInt` — and the row
flagged `must_set_passphrase`.

The generated value is shown exactly once. `generateInitialCredential`
returns the plaintext and the hash together; only the hash is stored.

- **First launch.** `bootstrapFirstAdmin` runs from the api launcher.
  If the instance has no users at all it creates the administrator and
  returns the passphrase once. The launcher writes it to `process.stdout`
  directly, **not through the logger** — it is the one line an operator
  has to find in `docker compose logs`, and it must not be buried in a
  JSON envelope or dropped by a log level. The function is guarded by
  the user count and catches the insert conflict, so it is a no-op on
  every later boot and safe to race across processes.
- **Administrator reset.** `resetPassphrase` replaces the credential
  with a fresh generated one, returns it once, clears the lockout
  counters and sets `must_set_passphrase`.

While that flag is set, `requireUser` answers **403
`passphrase_setup_required`** on everything except five paths:
`/api/auth/passphrase` (the way out), `/api/auth/policy` (the rule text
the screen prints), `/api/auth/login`, `/api/me` (the identity it
renders) and `/api/me/session` (sign-out). The generated value works for
signing in and for nothing else, so it cannot become the account's
long-term credential by inattention.

`setPassphrase` requires the current passphrase — a stolen session must
not be enough to take an account over — **except** when
`must_set_passphrase` is set, where the sign-in that got the caller here
just proved it. It also rejects re-setting the passphrase already in
use.

### There is no self-service reset, and that is the decision

A "forgot your passphrase" link needs to send mail. A self-hosted
install has no guaranteed way to send mail, and a reset link that
vanishes into a misconfigured relay is a worse experience than a page
that says an administrator has to do it.

So the reset path is: an administrator resets the account and hands over
the generated value out of band. It is honest about what it requires and
it works on an instance with no network egress at all.

`AEOLUS_MAIL_FROM` exists and enables outbound notification mail when an
operator has a sender; unset, mail is captured in memory and nothing is
sent. Nothing in the authentication path depends on it, and nothing in
the authentication path should be allowed to start.

### What a failed attempt costs

- An **unknown email** is verified against a fixed decoy hash
  (`DUMMY_HASH`) so it costs the same time as a wrong passphrase.
  Without that, response time answers "does this address have an account
  here".
- Both cases raise the same `InvalidCredentialsError` (401). The caller
  cannot enumerate accounts.
- Ten consecutive failures lock the account for fifteen minutes
  (`MAX_FAILED_ATTEMPTS`, `LOCKOUT_MS`), answered as **429** with the
  remaining seconds. Any successful sign-in resets the counter.
- The **disabled** check runs *after* the passphrase check, so a
  disabled account is not distinguishable from a wrong passphrase by
  anyone who does not already hold the credential. Holders get a
  specific **403 `account_disabled`**, because for them it is
  actionable.
- The per-IP sign-in budget (30/min, [`0025`](0025-browser-plane-edge-hardening.md))
  is the other half: the lockout handles one account under attack, the
  rate limit handles a spray across many.

A failed sign-in is deliberately **not** written to the audit log — see
[`0015`](0015-audit-log.md).

## Consequences

- `docker compose up` produces a usable instance with no external
  dependency of any kind. That is the property this decision exists to
  buy, and everything above is downstream of it.
- The instance now holds password-equivalent secrets, which it did not
  before. `AEOLUS_COOKIE_SECRET` and the database are correspondingly
  more valuable; `0022`'s reasoning about what the compile worker can
  read applies directly.
- The schema change was two steps before publication: drop
  `invitations`, `passkeys`, `webauthn_challenges` and
  `app_settings.allowed_invite_email_domains`, then add
  `passphrase_hash`, `passphrase_set_at`, `must_set_passphrase`,
  `failed_attempts` and `locked_until` to `users`. Both are folded into
  the squashed `0000_initial.sql` the published repository ships, so a
  new install creates the final shape directly. There is no migration
  path from the external-provider era: those installs had no local
  credential to carry over.
- An operator who *does* run an identity provider has lost the ability
  to use it. Adding OIDC back as an **option** is a reasonable feature —
  the seam is `authenticate()` returning an `AuthenticatedIdentity` —
  but it must stay optional, because the default install cannot depend
  on it.

## Alternatives considered

- **Keep OIDC and make it required.** Rejected: it makes the project
  unrunnable without a second system, which is the opposite of
  self-hostable.
- **Argon2id via a native binding.** Rejected on install fragility, as
  above. Worth revisiting if a pure-JS or WASM Argon2id becomes fast
  enough to be honest at these parameters.
- **A conventional password policy** with character classes and expiry.
  Rejected: it is what SP 800-63B specifically advises against, and it
  produces worse credentials than the length rule does.
- **Email-based self-service reset.** Rejected: it requires mail, and
  the install cannot promise mail. Revisit if a future release ever
  makes a mail server a hard requirement — it should not.
- **A `zxcvbn`-style strength estimator** instead of the denylist and
  pattern checks. Rejected for now on dependency weight for a check that
  runs a few times per account; the checks in `checkPassphrase` catch
  the realistic low-entropy choices at 16-plus characters, which is the
  only range this policy has to cover.
