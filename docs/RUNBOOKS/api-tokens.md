# API tokens

## When to use this

- Someone asks for programmatic access to Aeolus.
- A token is suspected leaked, or belonged to someone who has left.
- A `/api/v1` caller is failing and you need to tell *which* gate refused it.

Design rationale is in
[`docs/DECISIONS/0020`](../DECISIONS/0020-self-service-api-tokens.md);
the caller-facing contract is [`docs/API.md`](../API.md).

## Prerequisites

- An account on this instance, and network reach to it. Substitute your
  own hostname for `https://aeolus.example.com` throughout.
- The account must be past first-run setup. Aeolus signs people in with
  an email address and a passphrase it checks itself
  (`apps/api/src/services/credentials.ts`); there is no identity
  provider and no group membership in the way.

## Granting someone access — there is nothing for you to do

**This is not an operator task.** No secret to populate, no redeploy, no
configuration change.

1. Make sure they have an account. An administrator creates one at
   `/admin/users` (`POST /api/admin/users`), which answers with a
   **generated passphrase shown exactly once**. Hand that to them out of
   band; only its scrypt hash is stored, so it cannot be looked up later.
   If they have lost it, an admin issues a new one with
   `POST /api/admin/users/:id/reset-passphrase` — same one-time display.
2. They sign in with it at `/login`. The account is flagged
   `must_set_passphrase`, so `requireUser`
   (`apps/api/src/middleware/require-user.ts`) answers
   `403 passphrase_setup_required` on every route except the setup ones
   until they choose their own at `/passphrase`. **A person still on a
   generated credential cannot mint a token** — `POST /api/tokens` goes
   through the same gate.
3. Point them at `https://aeolus.example.com/tokens`.
4. They mint their own.

On a brand-new instance there is nobody to do step 1: when the `users`
table is empty, `apps/api/src/bin/server.ts` calls `bootstrapFirstAdmin`
at boot, creates one administrator (`AEOLUS_BOOTSTRAP_ADMIN_EMAIL`, or
`admin@localhost`) and writes its email and generated passphrase straight
to stdout, once.

```bash
docker compose logs api | grep -E '^ +(email|passphrase):'
```

Every later boot finds users and does nothing, so this is a one-time read.

⚠ **Never mint a token on someone else's behalf.** It would be *your*
credential carrying *your* document permissions, attributed to you in
every audit row, and the handover channel (email, chat) would retain a
live secret indefinitely. If they cannot sign in, fix the sign-in.

## Revoking a token

Any signed-in user can revoke any token — deliberately, so a revoke never
waits on one person being reachable.

1. Go to `/tokens`.
2. Find the row. The 16-character id next to the name is the same id that
   appears in the API's logs, so a log line identifies a row exactly.
3. **Revoke**, and confirm.

Effective on the very next request — there is no cache to expire. The row
is deleted rather than flagged: the hash *is* the credential, so there is
no second state to keep in sync.

Both mint and revoke land in the audit log
(`GET /api/admin/audit-events?action=token`), and the revoke record keeps
the former owner's email even though the row is gone.

### Offboarding

You do **not** need to hunt for someone's tokens. Disabling their user
401s every token they minted on its next request, and deleting the user
removes the rows outright by foreign key. Do the usual offboarding and the
credentials follow.

## Triage: which gate refused a call?

Match on the `error` code, not the status alone.

| Response | What it means | What to do |
| --- | --- | --- |
| `401 unauthenticated` | No token, malformed, unknown, revoked — or its owner is disabled or deleted. | Check the token still exists at `/tokens`, and that its owner is still enabled. |
| `403 read_only_token` | Valid credential, but read-scope on a write method. | Mint a write-scope token. **Do not** retry — the credential is fine, so a retry loops. |
| `403 forbidden` | Valid credential; its **user** lacks permission on that document. | Scope is not the ACL. Give the *user* access, or use a token minted by someone who has it. |
| `404 not_found` | No such route — or a document its user cannot see (ADR 0003 hides existence). | Check the path, then check the user's access. |
| `429 rate_limited` | Over 120 req/min for that credential. | Honour `retry-after`. Buckets are per credential, so this is one caller's problem. |
| `503 token_store_unavailable` | The token could not be **checked** — a database blip. Body carries `"retryable": true`. | Retry. ⚠ Do not discard the token; it is probably fine. |
| A response with **no JSON body** | Not Aeolus at all — whatever you put in front of it. | See below. |

That last row is worth knowing. Every refusal Aeolus itself issues carries
the house envelope, `{ "error": …, "message": … }`. A bare status page, an
HTML error, or a body naming some other product came from the reverse
proxy or load balancer in front of the stack, never reached a route, and
left no application log line. In the shipped compose stack that is Caddy
(`Caddyfile`); check `docker compose logs caddy`.

## Verification

Confirm a token works, and that its scope behaves:

```bash
# 200, and `user` is the person who minted it
curl -sS https://aeolus.example.com/api/v1/me \
  -H "authorization: Bearer $AEOLUS_TOKEN"

# a read-scope token on a write method: 403 read_only_token, NOT 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  https://aeolus.example.com/api/v1/me \
  -H "authorization: Bearer $AEOLUS_TOKEN"
```

Confirm a revoke took effect: re-run the first command and expect `401`.

Confirm the audit trail: `/admin/audit`, filter action `token`.
