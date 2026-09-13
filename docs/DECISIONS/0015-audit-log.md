# 0015 — Audit log: in-DB, 30-day retention, sweep-on-read

- **Status**: accepted — action list re-stated 2026-09-13 against the
  current `AuditAction` union; the storage, retention and sweep
  decisions are unchanged.
- **Date**: 2026-05-01
- **Deciders**: davidemerson

## Context

An administrator investigating an incident wants a per-user,
per-action history they can scan: who signed in, who created or
deleted a document, who minted a credential, who changed a setting.
They want it in the admin panel, queryable, without leaving the app —
which is the whole point, because an operator who has to go and find a
log aggregator will not look.

Aeolus therefore keeps its own log in its own database. There is no
external archive, and none is assumed: whether the container's stdout
goes anywhere durable is the operator's decision, not the
application's.

## Scope of "audit-worthy"

The full list is the `AuditAction` union in `apps/api/src/audit.ts`,
which is the authority. As of 2026-09-13 it covers:

- **Authentication** — `auth.login`, `auth.logout`,
  `auth.passphrase_set`, `auth.passphrase_reset`.
- **User management** — `user.create`, `user.update`, `user.disable`,
  `user.enable`, `user.delete`.
- **Documents** — `doc.create`, `doc.update`, `doc.delete`,
  `doc.archive`, `doc.unarchive`, `doc.open`,
  `doc.collaborator.add`, `doc.collaborator.remove`.
- **Files** — `file.create`, `file.upload`, `file.rename`,
  `file.write`, `file.delete`. These had no coverage at all when every
  caller was a human in the editor, and needed it once a long-lived
  machine credential could reach them.
- **Templates** — `template.create`, `template.update`,
  `template.delete`, `template.fork`.
- **Version history** — `checkpoint.create`, `checkpoint.restore`,
  `project_checkpoint.create`, `project_checkpoint.restore`,
  `project_checkpoint.delete`.
- **Credentials** — `token.mint`, `token.revoke`, `ws.ticket.mint`.
- **Assist and housekeeping** — `ai.assist`, `admin.blob_gc`.

Two deliberate omissions, both about signal:

- **A failed sign-in is not logged.** It would flood the table on a
  typo. The account lockout in `apps/api/src/services/credentials.ts`
  is the control that matters for guessing, and the per-IP limit in
  `middleware/rate-limits.ts` is the control for spraying.
- **Auto-open checkpoints are not logged.** They fire on every editor
  mount; burying real events under that noise makes the trail useless.

`doc.open` *is* logged, and is the highest-volume row by a wide margin
— every load of the editor emits one. With 30-day retention even a
50-user team browsing 50 documents a day generates around 75,000 rows,
which is nothing for Postgres.

## Storage shape

Single table `audit_events`:

| column | notes |
| --- | --- |
| `id` | uuid, generated. |
| `occurred_at` | timestamptz default now(). Indexed DESC for the list endpoint. |
| `actor_id` | FK→users(id) ON DELETE SET NULL. Goes null when the user is deleted; `actor_email` carries the durable identifier. |
| `actor_email` | Captured at event time. Survives user deletion or rename so the log stays readable. |
| `action` | Namespaced string (`doc.create`, `auth.login`, …). |
| `resource_type`, `resource_id` | Optional handle on the affected entity. |
| `metadata` | jsonb. Free-form; common keys `title`, `engine`, `collaborator_user_id`, `role`. |
| `ip`, `user_agent` | From the request; see below. |

Indexes cover the three access patterns the admin UI needs:
`(occurred_at DESC)` for the feed, `(actor_id, occurred_at DESC)` to
filter to a person, `(action, occurred_at DESC)` to filter to an
action.

### `ip` is only as true as the proxy configuration

`auditFromRequest(request)` takes the first `X-Forwarded-For` hop when
one is present and the socket address otherwise. That first hop is
client-supplied unless something trustworthy overwrote it, so the
column is honest only when `AEOLUS_TRUST_PROXY` names the reverse
proxy in front of the api — the compose stack sets `uniquelocal` for
exactly this reason. Left unset behind a proxy, every row records the
proxy; set to `true` on a directly reachable app, every row records
whatever the caller typed.

## Helper API

`apps/api/src/audit.ts`:

- `emitAudit(db, { action, actorId, actorEmail, resourceType,
  resourceId, metadata, ip, userAgent })` writes a row. Insert
  failures are caught and written to stderr as one JSON line — an
  audit failure must never abort the user's action.
- `auditFromRequest(request)` extracts `{ ip, userAgent }` (the
  user-agent truncated to 500 characters).
- `pruneOldAuditEvents(db, retentionDays = AUDIT_RETENTION_DAYS)`
  deletes rows past the window.

Route handlers do not call these directly. `ServiceContext.audit` is
pre-bound with the request's IP, user-agent and actor, so a call site
names only what happened, and a change driven by an API token is
attributed automatically — see
[`0021`](0021-service-layer-extraction.md).

## Retention

30 days (`AUDIT_RETENTION_DAYS`), enforced **as a side effect of the
most frequent admin action**: the list endpoint sweeps rows older than
the window before serving a page. No scheduler, no pg_cron, no
background worker.

If nobody looks at the log, retention stretches. That is an acceptable
failure mode, because the only caller who would see those stale rows
is by definition an administrator about to look at the log and trigger
the sweep.

The list endpoint also bounds results to `now() - 30d`
unconditionally, so a custom `before` cursor cannot time-travel past
the window.

## Authorization

The list endpoint is admin-only: non-admins 403, unauthenticated 401.
Audit *writes* happen only from server-side code paths — there is no
emit endpoint, so no caller can forge a row.

## What's deferred

- **Shipping the log off the box.** `audit_events` is shaped to be a
  clean source for a forwarder — typed columns plus a JSON metadata
  bag — but nothing forwards it, and the pruning sweep is independent
  of anything that might, so a mirror would keep rows this table has
  dropped.
- **Append-only storage.** An administrator with database access can
  delete from `audit_events`. Acceptable, because that same person can
  already alter far more sensitive state; a tamper-evident record needs
  a sink outside the instance, which is the previous bullet.
- **Digests and email summaries.** No mail server is assumed — see
  [`0026`](0026-local-passphrase-authentication.md) for why that
  assumption is load-bearing elsewhere too.
