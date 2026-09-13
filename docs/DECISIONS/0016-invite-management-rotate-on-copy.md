# 0016 — Invitation management: rotate-on-copy, merged into /admin/users

- **Status**: **superseded by [`0026`](0026-local-passphrase-authentication.md)** —
  the invitation flow this ADR designs no longer exists. The
  `invitations`, `passkeys` and `webauthn_challenges` tables and the
  `app_settings.allowed_invite_email_domains` column were dropped before
  publication and are not in the schema. Under 0026 an
  administrator creates the account directly and hands over a generated
  passphrase shown once, so there is no token to rotate, no link to
  copy and no mail to resend. Retained as history: the rotate-on-copy
  argument below is the reason the passphrase reset in
  `services/credentials.ts` also shows its value exactly once and never
  again.
- **Date**: 2026-05-02
- **Deciders**: davidemerson

> Everything below describes code that has been removed. It is kept for
> the reasoning, not as a description of the application.

## Context

The original invitation surface was a single create-only page
(`/admin/invite`) that produced a token and emailed it. Operators
asked for three follow-up actions on a pending invitation:

1. **Copy invite link** — hand the link to the invitee out-of-band
   (Slack, ticket comment) when the email never arrives.
2. **Resend email** — re-fire the invite when the recipient asks
   for a fresh prompt.
3. **Revoke** — delete a pending invite (e.g. wrong email, role
   change, person no longer joining).

The constraint that shaped the design: we **never persist the raw
token**. The `invitations` table stores only the SHA-256 hash, by
the same security argument as password hashing — a database leak
should not yield usable invite links, and the credential-reset path
already relied on this property. Without the raw token on disk,
there is no way to surface the original `invite_url` after the
creation response is gone.

## Decision

### 1. Rotate on every "Copy link"

Pressing **Copy link** in the admin UI maps to
`POST /admin/invitations/:id/rotate`, which generates a new random
token, replaces `invitations.token_hash`, refreshes `expires_at`
(7-day TTL), returns the fresh `invite_url`, and **does not send
email**. The previous link — if anyone had it — is now dead.

This is the only design that satisfies the constraint *and* the
operator's request without persisting raw tokens. The trade-off
is benign: invitees rarely have two paths to the link
simultaneously, and rotating early is strictly more secure than
the alternative ("sticky" links that survive any number of
copy/resend operations).

The UI surfaces this with the toast text *"Invite link copied
(previous link invalidated)"* so the operator isn't surprised
when an out-of-band paste from earlier stops working.

### 2. Resend = rotate + email

`POST /admin/invitations/:id/resend` shares the rotate path and
also pushes the new URL through the configured `MailAdapter`. Same
security property: any older URL goes dead.

### 3. Revoke = hard delete

`DELETE /admin/invitations/:id` removes the row entirely. Accepted
invitations (where `accepted_at IS NOT NULL`) are refused with 404
so the audit trail for completed onboarding isn't mutated; the
operator should act on the resulting user via `/admin/users`
instead.

### 4. Merge `/admin/invite` into `/admin/users`

The Users page becomes the single surface for everything related
to user provisioning. It hosts the invite form (top), the
pending-invitations table (middle, with copy/resend/revoke), and
the existing user list (bottom). The standalone `/admin/invite`
route is deleted; the admin landing card is removed. One page is
easier to scan when an operator is investigating "who's pending"
vs "who's already in" without context-switching across two
routes.

### 5. Audit actions

Three new entries on the `AuditAction` union — `invitation.rotate`,
`invitation.resend`, `invitation.revoke` — emitted by the
respective handlers with `metadata.invitee_email` so the audit
log lets an investigator answer *"who was the invite for, who
acted, when"*.

## Consequences

- **Operators**: a single Users page; copy-link is fire-and-forget
  but kills the previous URL.
- **Invitees**: an invitee who had received an earlier email and
  not yet acted will find the old link 410s the next time the
  operator copies/resends. A new email will be on the way (or the
  operator hands the new URL out directly), so this rarely
  surprises in practice.
- **Future work**: if rotation-as-side-effect becomes a usability
  problem, the next iteration would be to issue a *separate*
  one-time view-link (signed, ephemeral) without rotating the
  invitation token. Not worth the complexity today.

## Test coverage

`tests/integration/invitations.test.ts` and
`tests/e2e/admin-invitations.spec.ts` covered these endpoints. Both were
deleted with the feature.
