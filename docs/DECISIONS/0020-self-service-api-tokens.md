# 0020 — Self-service API tokens, minted in the UI

- **Status**: accepted
- **Date**: 2026-09-04
- **Companion**: [`0019-machine-api-plane.md`](0019-machine-api-plane.md)
  decides the plane; this decides the credential that opens it.

## Context

`/api/v1` needs a credential that is not the session cookie — see 0019
for why the cookie cannot serve. There are two shapes to choose between.

**A static key in the environment**, e.g. `AEOLUS_API_KEYS` as a
comma-separated list. It is one shared value: anonymous in the logs,
identical for everyone who has it, and rotatable only by restarting the
stack. Revoking one holder means revoking all of them, which in practice
means nobody revokes it.

**Rows in the application's own database**, minted by the people who
will use them. Aeolus already owns a Postgres, so this costs one table —
and it makes granting access something a user does for themselves rather
than something an operator does by editing configuration and restarting
three containers.

## Decision

**A signed-in user mints their own token in the UI. Format
`aeolus_<16-hex-id>_<43-char base64url>`, presented as
`Authorization: Bearer`.**

- The **id half is public and is the primary key**, so verifying a
  presented credential is one indexed lookup plus a constant-time
  compare, not a scan over every live row.
- Only `sha256(whole token)` is stored. The plaintext exists in the
  response to the minting request and nowhere else — not recoverable by
  anyone, including an operator with database access. A plain SHA-256
  rather than a KDF is correct precisely because the input is 256 bits
  of uniform randomness, not a human-chosen password.
- The literal `aeolus_` prefix is deliberate: secret scanners key off
  prefixes, and a token pasted into a ticket is then recognisable as an
  Aeolus credential by whoever should revoke it.
- **Bearer, not `x-api-key`.** It is what OpenAPI's `http`/`bearer`
  security scheme describes natively, every HTTP client has a helper for
  it, and the reference UI's "Try it" box speaks it.

### A token acts as the user who minted it

This is the decision that matters most here.

The auth hook resolves the token to its creator, refuses a missing or
`disabled_at` user, and sets that user as the request actor. Everything
downstream — `resolveRole`, `assertCanRead`, `assertCanWrite`, the
admin checks — is **reused unchanged**. An API without a per-user ACL
could skip this; Aeolus's five-role document model
([`0003`](0003-acl-404-vs-403.md)) makes it the only sane option, since
the alternative is a second authorization system that has to agree with
the first forever.

Two consequences follow:

- **A token dies with its owner.** Disabling a user 401s their tokens on
  the next request, the same way it 401s their sessions; deleting the
  user removes the rows by FK cascade. `disabled_at` would otherwise
  have meant only "cannot use the browser".
- **Scope is not the ACL.** Both gates apply. A write-scope token minted
  by a viewer still gets 403 on that document; one minted by a
  non-collaborator still gets 404, per
  [`0003`](0003-acl-404-vs-403.md). This is the thing an API consumer
  will get wrong, so it has its own section in `docs/API.md`.

### Scope, by HTTP method, failing closed

`read` (RFC 9110 safe methods) or `write` (everything), fixed at mint.
The gate is by **method, not a route list**: a write route added later
is covered the day it ships, and the failure mode of forgetting to
classify one is a read-only token being denied rather than
over-permitted.

`scopeAllows` returns true for a write only when the scope is exactly
`'write'`. A row carrying null, empty, or an unrecognised value — a
partial migration, a hand-edited row, a future scope this build predates
— is therefore read-only. A test drops the CHECK constraint, writes
`'superuser'`, and asserts the token can read but not write.

A refused write is **403, not 401**: the credential is valid, so
re-authenticating cannot fix it, and a client that retries 401s by
fetching a new token would loop forever.

### Default `read`

The scope column arrived with the `api_tokens` table itself, so there
were never pre-existing rows to protect from a silent downgrade. Least privilege applies from the first row, and the two-step
`ADD COLUMN 'write'` / `SET DEFAULT 'read'` migration dance an existing
table would have needed is unnecessary.

### Everyone sees and revokes everything

Every signed-in user can list every token (name, scope, creator,
created, last used — never the secret) and revoke any of them.

Deliberate: a token authorises writes against shared documents, so who
holds one is operational information rather than personal, and a revoke
that waits for its owner to be reachable is a revoke that does not
happen.

The wrinkle, stated so nobody discovers it by surprise: because a token
acts as its creator, an admin's token is an admin credential, and a
non-admin can revoke it. That is the price of universal revocability,
and it is a trade an instance with a hostile user on it would not want.
Every revoke is audited (`token.revoke`) with the actor and the former
owner's email.

### Revocation is deleting the row

The hash *is* the credential, so there is no second meaning of "revoked"
to keep in sync. A soft `enabled = false` is worth having only when
something outside the application reads the table and needs the row to
still be there; nothing does.

### Minting is browser-plane only

`/api/tokens` is session-gated and unreachable with a bearer token. A
write-scope token that could mint tokens would be able to outlive its
own revocation by bootstrapping a successor.

It is **not** admin-gated: anyone who can sign in can mint one for
themselves, and what it can reach is bounded by what they can reach.

### `last_used_at`, throttled in SQL

Stamped at most once per token per five minutes, by a predicate in the
`UPDATE` rather than an in-process timestamp: an install may run more
than one api container, and an in-memory cache would let each of them
write once per window. Approximate by design — its job is to make "is
anything still using this?" answerable before somebody revokes.

## Consequences

- **Granting someone API access is not an operator task.** They sign in
  and mint one. There is no configuration to edit, no restart, and
  nothing for an operator to hand over a channel that would retain it.
- Every credential is a database row, so a database outage 401s… no:
  it answers **`503 token_store_unavailable`**, deliberately distinct,
  because a client that reads a transient 401 as "revoked" throws away a
  good credential.
- No static env-var key exists, and none should be added. If a consumer
  ever genuinely must survive a Postgres outage, that is the moment to
  reconsider — bearing in mind that the app cannot serve a document
  during one either, so the credential is not the thing that broke.
- No read-only *plane*, only read-only tokens: a `read` token can read
  every document its owner can read. Per-document scoping is a
  reasonable follow-up if a consumer ever needs a token narrower than
  its holder.

## Alternatives considered

**A static `AEOLUS_API_KEYS` env var.** Rejected: shared, anonymous in
the logs, always full-scope, rotatable only by restarting the stack, and
issuing one means an operator editing `.env` and then getting the value
to a person over some channel that will keep a copy of it.

**A token as its own principal, with its own permissions.** Rejected:
a second authorization model that must agree with the document ACL
forever, and the first disagreement is a security bug. Acting as the
minting user means there is one model.

**`enabled = false` instead of deleting on revoke.** Rejected: the row
*is* the credential, so keeping a dead one only creates a second meaning
of "revoked" for the auth hook and the admin UI to disagree about.

**Admin-only minting.** Rejected: it recreates the issuance-and-delivery
problem this decision exists to remove, and it buys nothing — a token is
bounded by its holder's own access either way.
