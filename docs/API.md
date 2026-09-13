# Aeolus API (`/api/v1`)

The machine-facing, token-authenticated plane of Aeolus, a
collaborative LaTeX and Typst editor you host yourself. Use it to drive
Aeolus from automation: CI that compiles on merge, scripts that sync
source in, agents that file drafts.

> The UI routes (`/api/*`, no version) are session-cookie-gated and are
> **not** part of this contract. Everything below is the stable
> `/api/v1/*` surface.

**This document describes what is shipped.** The "Not yet" section at
the end lists what is left out on purpose — those omissions are
deliberate, not pending.

## Base URL

Whatever host your instance answers on. Every example below uses:

```
https://aeolus.example.com
```

Aeolus is self-hosted, so there is no vendor endpoint and no default
hostname. The shipped `docker compose` stack serves plain HTTP on
`http://localhost:8080`; put a real hostname in `AEOLUS_SITE_ADDRESS`
and Caddy takes out a certificate for it (see `Caddyfile`). Whether
that host is reachable from the public internet, from a VPN, or from
one machine is your decision and is not a control this API relies on —
the bearer token is.

## Authentication

Every request carries a bearer token:

```
Authorization: Bearer aeolus_9f2c1a04b7e6d380_kJ3…
```

**Mint your own** in the UI → **Tokens** (sign in at
`https://aeolus.example.com`, then `/tokens`). The value is shown
**once**, at creation — copy it into your password manager there and
then. Only a SHA-256 hash is stored, so a lost token cannot be recovered
by anyone, including an operator with database access: revoke it and
mint another.

Session cookies are **not** accepted on this plane. Aeolus rotates the
session token on every authenticated request, so a client that ignores
`Set-Cookie` would get exactly one call per credential — which is the
whole reason tokens exist.

### Scope

A token is minted **read-only** (the default) or **read & write**, and
the choice is fixed for its lifetime — to change it, mint a new token
and revoke the old one. Read-only permits `GET`, `HEAD` and `OPTIONS`. A
write attempted with one is refused **before the route runs**:

```
403 {"error":"read_only_token","message":"This token is read-only; a write-scope token is required","scope":"read"}
```

`403` rather than `401` is deliberate — the credential is valid, so
re-authenticating cannot fix it, and a client that retries 401s by
fetching a new token would loop forever. The gate is by HTTP method, not
a route list, so a write route added later is covered from the day it
ships.

### Scope is not the ACL

This is the part that surprises people, so it gets its own section.

**A token also carries its minting user's document permissions.** Both
gates apply, in this order: scope first, then the ordinary Aeolus
document ACL.

So a **read & write** token minted by someone with *viewer* access to a
document still cannot write it — that is `403 forbidden` from the ACL,
not from the scope gate. And a token minted by someone with no access at
all gets `404`, not `403`, because Aeolus hides the existence of
documents you cannot read.

If a call fails unexpectedly, check *whose* token it is before you check
its scope.

### Lifecycle

Every signed-in user can see every token (name, scope, creator, created,
last used — never the secret) and revoke any of them. This is
deliberate: a token writes to shared documents, so who holds one is
operational information, and a revoke that waits for its owner to be
available is a revoke that does not happen. Revocation takes effect on
the next request.

A token **dies with its owner**: disabling that user 401s the token
immediately, and deleting them removes it outright. The same check covers
someone who has not finished setting up: a token whose owner is still on a
system-generated passphrase (`must_set_passphrase`) 401s, so a credential
cannot act on behalf of an account its owner has not yet claimed.

`last_used_at` is stamped at most once per token per five minutes —
enough to tell a live token from an abandoned one before somebody
revokes it, and deliberately not a request counter.

### Failure modes

| Status | Body `error` | Meaning |
| --- | --- | --- |
| `401` | `unauthenticated` | Missing, malformed, unknown or revoked token; or its owner is disabled or deleted. |
| `403` | `read_only_token` | Valid credential, wrong scope for this method. Do **not** retry with a new token. |
| `403` | `forbidden` | Valid credential, but its user lacks permission on this resource. |
| `404` | `not_found` | No such route, or a document its user cannot see. |
| `429` | `rate_limited` | Over budget; honour `retry-after`. |
| `413` | `payload_too_large` | Body over the 5 MiB limit (uploads: 25 MiB per file via `/files/upload`). |
| `415` | `unsupported_media_type` | Wrong `content-type` for the route. |
| `503` | `token_store_unavailable` | The credential could not be **checked** — a database blip, not a bad token. Retryable; the body carries `"retryable": true`. Do not discard your token on this. |
| `503` | `compile_unavailable` | The compile queue is not configured. Not about your request. |

## Conventions

- JSON in, JSON out. `snake_case` on the wire.
- Errors are `{ "error": "<code>", "message": "<human>" }`. The `error`
  code is the stable part; match on it, not on `message`.
- Timestamps are ISO-8601 UTC.
- A legitimately-absent sub-resource of a readable parent is `204`, not
  `404` — see [ADR 0018](DECISIONS/0018-204-for-absent-subresources.md).
- Unauthorized reads are `404`, not `403`, so the API does not confirm
  that a document exists to someone who cannot read it — see
  [ADR 0003](DECISIONS/0003-acl-404-vs-403.md).

## Rate limits

**120 requests per minute per token.** Exceeding it returns `429` with a
`retry-after` header. The bucket is keyed on the credential, so one
noisy job cannot throttle another team's token.

Limits are enforced in the application, not at the edge: a self-hosted
install typically sits behind one reverse proxy, so an IP-keyed limit at
that layer would meter every caller as one.

---

## `GET /api/v1/me`

Who this token authenticates as, and what it is allowed to do. The
cheapest way to check a credential works.

`200` →

```json
{
  "user": {
    "id": "531c7eaa-5ef9-4f73-8675-04c755ce2c6b",
    "email": "someone@example.com",
    "name": "Someone",
    "is_admin": false
  },
  "token": {
    "id": "218b9e1c9f5cac45",
    "name": "nightly-thesis-build",
    "scope": "read"
  }
}
```

`user` is the person the token acts as — the same identity the document
ACL is evaluated against. `token.scope` saves a client discovering its
own scope by taking a 403.

```bash
curl -sS https://aeolus.example.com/api/v1/me \
  -H "authorization: Bearer $AEOLUS_TOKEN"
```

---

## `PATCH /api/v1/me`

Change your own display name. It is the only thing you can change about
yourself; the email address is the sign-in identifier and only an
administrator changes it, via `PATCH /api/v1/admin/users/{id}`.

```bash
curl -sS -X PATCH https://aeolus.example.com/api/v1/me \
  -H "authorization: Bearer $AEOLUS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Nightly Build"}'
```

`200` → `{"user": {…}}` with the updated record. A token does this as the
user who minted it, so a bot that renames itself renames a person — which
is a good reason to mint tokens from a service account if you have one.

Write scope. Needs no admin.

---

## `GET /api/v1/ai/quota`

What is left of the Claude-assist allowance for the user this token acts
as.

`200` →

```json
{
  "hourly":      { "used": 3,    "limit": 30 },
  "daily":       { "used": 11,   "limit": 200 },
  "dailyTokens": { "used": 8421, "limit": 50000 }
}
```

The quota is **per user, not per token**, so every token a person mints
spends the same allowance — and so does that person working in the
editor. Worth reading before a batch job rather than discovering the
ceiling as a stream of failures.

Assist itself is `POST /api/v1/ai/assist`, below.

---

## Documents

A *document* is a project: a title, an engine (`latex` or `typst`), an owner,
and a file tree. These routes cover the document itself and who can reach it;
its files and content are the next domain to land.

Two states are independent of each other:

- **`archived_at`** — a read-only lock. Writes return `422 archived` for owners
  and editors alike. Owner or admin can toggle it; an editor cannot.
- **`deleted_at`** — a soft delete. The document leaves everyone's listing, and
  a non-admin can no longer fetch it at all (`404`). An **admin** can still
  fetch it and can list it with `include_deleted=true`, which is what makes an
  undelete possible.

### `GET /api/v1/docs`

Documents the token's user owns or collaborates on, newest-updated first.
Admins see every non-template document.

| Query | |
|---|---|
| `status` | `active` (default, hides archived) · `archived` · `all` |
| `include_deleted` | admin-only; ignored for everyone else |

`200` →

```json
{
  "docs": [
    {
      "id": "0f0e1c8a-...",
      "title": "Q3 threat report",
      "engine": "latex",
      "owner_id": "531c7eaa-...",
      "archived_at": null,
      "deleted_at": null,
      "created_at": "2026-09-04T18:00:00.000Z",
      "updated_at": "2026-09-04T19:12:00.000Z"
    }
  ]
}
```

### `POST /api/v1/docs`

**Admin only** — everyone else creates documents by forking a curated template,
which is the brand-controlled path. A non-admin gets `403 forbidden` however
wide the token's scope.

Body `{ "title": "...", "engine": "latex" | "typst" }` → `201 { "id": "..." }`.

### `GET /api/v1/docs/{id}`

`200 { "doc": { ... } }`. `404` if it does not exist **or** the token's user
cannot read it — the two are deliberately indistinguishable.

### `PATCH /api/v1/docs/{id}`

Body `{ "title": "..." }` → `200 { "doc": { ... } }`. Owner, editor or admin.
`422 archived` if the document is archived.

### `DELETE /api/v1/docs/{id}`

`204`. Soft delete. **Owner or admin only** — an editor gets `403`.

### `POST /api/v1/docs/{id}/archive` · `POST /api/v1/docs/{id}/unarchive`

`200 { "doc": { ... } }`. Both idempotent. Owner or admin only.

### `GET /api/v1/docs/{id}/collaborators`

Readable by anyone who can read the document. The owner is not listed — they
are `doc.owner_id`.

```json
{ "collaborators": [ { "id": "...", "user_id": "...", "email": "a@b.com", "role": "editor" } ] }
```

### `POST /api/v1/docs/{id}/collaborators`

Body `{ "email": "...", "role": "editor" | "viewer" }` → `201`. Owner or admin.

The target **must have signed in at least once**: Aeolus has no invite flow, so
there is no user row to grant against until they do. `409 user_not_found` if
not, `409 already_collaborator` if they already are.

### `DELETE /api/v1/docs/{id}/collaborators/{userId}`

`204`. `404` if they were not a collaborator — this is not idempotent, and a
second call tells you so.

## Files and content

A document's file tree: text files, uploaded blobs, and folders. Text
content lives in a CRDT, not a column — the same source the compile
worker reads — so what you read is what would compile, and what you
write is coherent with anyone editing the file in a browser.

### `GET /api/v1/docs/{id}/files`

The whole tree, ordered by path.

```json
{
  "files": [
    { "id": "…", "path": "main.tex", "kind": "text", "yjs_doc_id": "…",
      "size_bytes": 1841, "mime_type": null,
      "created_at": "…", "updated_at": "…" },
    { "id": "…", "path": "figures/plot.png", "kind": "blob", "yjs_doc_id": null,
      "size_bytes": 20481, "mime_type": "image/png", "…": "…" }
  ]
}
```

`size_bytes` for a text file is **computed** from its CRDT, so it
includes edits that have not been compacted into a snapshot yet.

### `POST /api/v1/docs/{id}/files`

Body `{ "path": "chapters/intro.tex", "kind": "text" | "folder" }` →
`201`. `kind` defaults to `text`.

Paths are relative and `/`-separated. `..`, `.` and empty segments are
refused with `400 invalid_path`. A **leading slash is stripped**, not
rejected — `/notes.tex` becomes `notes.tex`. Paths only ever name rows
in this document's own tree; nothing resolves them against a filesystem.

`409 path_taken` if something is already there.

### `GET /api/v1/docs/{id}/files/{fileId}/content`

```json
{ "path": "main.tex", "content": "\\documentclass{article}…", "rev": "42" }
```

`422 not_a_text_file` for a blob or folder.

**Keep the `rev`.** Pass it as `if_rev` on a write to make the write
conditional.

### `PUT /api/v1/docs/{id}/files/{fileId}/content`

Body `{ "content": "…", "if_rev": "42" }` → `200 { "path", "rev" }`.

The new text is applied as a single CRDT transaction against the live
document, and any browser with the file open is told to re-bootstrap. It
is *not* a column overwrite — a collaborator mid-edit stays coherent
instead of desynchronising.

`if_rev` is optional optimistic concurrency:

```
412 {"error":"revision_mismatch","message":"…","rev":"47"}
```

The response carries the revision the file is **actually** at, so a
client can re-read and retry without guessing. Omit `if_rev` and the
last writer wins, which is usually what a one-shot script wants.

### `POST /api/v1/docs/{id}/files/upload`

`multipart/form-data`. `file` is the payload; `path` is where it lands
(defaults to the uploaded filename).

Allowlisted by extension — `.png .jpg .jpeg .pdf .bib .cls .sty .ttf
.otf .csv` — with `400 unsupported_type` otherwise. 25 MB per file
(`413 file_too_large`), 200 MB per project (`413 quota_exceeded`).

### `PATCH /api/v1/docs/{id}/files/{fileId}`

Body `{ "path": "…" }` → `200`. Renaming a **folder** rewrites every
descendant's path in the same transaction. The main entrypoint
(`main.tex` / `main.typ`) cannot be renamed — the compile worker finds
it by path — which is `422 main_file_locked`.

### `DELETE /api/v1/docs/{id}/files/{fileId}`

`204`. A non-empty folder is refused rather than cascading deletions you
did not ask for:

```
422 {"error":"folder_not_empty","message":"…","children":3}
```

A blob's bytes are removed only when nothing else references them — a
project checkpoint may have pinned the object, and forked documents
share a template's objects by reference.

## Templates

Admin-curated starting points. **Forking one is how a non-admin creates
anything** — `POST /api/v1/docs` is admin-only, by design, because the
document set is brand-controlled.

An unpublished template is a draft: invisible to non-admins in both the
list and a direct fetch (`404`, not `403` — same existence-hiding rule as
documents).

### `GET /api/v1/templates` · `GET /api/v1/templates/{id}`

```json
{ "templates": [ { "id": "…", "name": "Threat report", "description": "…",
                   "engine": "latex", "is_published": true,
                   "yjs_doc_id": "…", "created_by": "…",
                   "deleted_at": null, "created_at": "…", "updated_at": "…" } ] }
```

`yjs_doc_id` is the template's backing document — an admin edits it
through the ordinary document and file routes.

### `POST /api/v1/templates` · `PATCH` · `DELETE`

**Admin only.** Create takes `{ name, description?, engine }`. Publishing
is `PATCH { "is_published": true }`, and that is what makes a template
visible and forkable by everyone else. Delete is a soft delete and takes
the backing document with it; documents already forked from it are
unaffected.

### `POST /api/v1/templates/{id}/fork`

Body `{ "title": "…" }`, or **no body at all** to take the template's
name.

```json
{ "doc_id": "…", "title": "My paper", "text_files_copied": 2, "blobs_copied": 1 }
```

Two properties worth relying on:

- **Every text file is copied, not just the entrypoint.** Each keeps its
  path and its content, so `\\input{}` siblings survive. (They did not,
  once — issue #36.)
- **Blobs are copied by reference.** A fork is a snapshot of the template
  at fork time; the template later deleting a logo does not pull it out
  from under existing forks, and forking a popular template does not
  duplicate its bytes.

The new document is owned by the caller and carries
`forked_from_template`.

## Compiling

The loop is: start a compile, poll until it finishes, download the PDF.

```bash
JOB=$(curl -sS -X POST "$B/api/v1/docs/$DOC/compile" -H "authorization: Bearer $T" | jq -r .job_id)

until [ "$(curl -sS "$B/api/v1/docs/$DOC/compile/$JOB" -H "authorization: Bearer $T" | jq -r .status)" != "queued" ]; do sleep 2; done

curl -sS "$B/api/v1/docs/$DOC/compile/$JOB/download" -H "authorization: Bearer $T" -o out.pdf
```

### `POST /api/v1/docs/{id}/compile`

`202` with `{ job_id, doc_id, engine, rev, status: "queued" }`.

**Rate limited to 6 per minute per token** — each one is a container-minute
of Tectonic or Typst. `409 unsupported_engine` for a document whose engine
is neither. `503 compile_unavailable` if the queue is not configured.

### `GET /api/v1/docs/{id}/compile/{jobId}`

Poll this. `status` is `queued` → `running` → `success` | `failed`.

On failure, **`error` carries the engine log excerpt** — print that in CI
rather than making someone open the editor.

On success, `pdf_url` and `synctex_url` are paths relative to `/api`.
**`warnings` is an array, empty when clean.** A non-empty one means the PDF
built but will not look to a recipient the way it looks in the previewer —
today that is a font the PDF references without embedding it, which renders
as blank text in Acrobat. A CI job that publishes PDFs should fail, or at
least log loudly, on a non-empty `warnings`.

### `GET /api/v1/docs/{id}/compile/latest`

The newest **successful** compile, ignoring any failures after it.
**`204` when the document has never compiled successfully** — a normal
state, not an error.

`is_current` says whether that PDF still matches the project, so you can
skip a rebuild. It is deliberately *not* a revision comparison: editing a
sibling file or adding an image does not move `rev`, so the server
compares timestamps across the whole project — and errs toward `false`,
because an unnecessary compile costs seconds and a stale PDF costs trust.

### `GET /api/v1/docs/{id}/compile/{jobId}/download`

Streams `application/pdf`. **This is the only route to the bytes** —
there is no public or presigned URL. `?inline=1` flips
Content-Disposition.

### `GET /api/v1/docs/{id}/synctex/latest` · `GET /api/v1/docs/{id}/compile/{jobId}/synctex`

The source↔PDF position map, LaTeX only.

The two differ on purpose. `latest` answers **`204`** when there is none —
never compiled, or a Typst document, which emits no synctex ever. Naming a
specific job instead gets a **`404`**, because "that job has none" is an
answer about that job.

### `GET /api/v1/docs/{id}/download.zip`

The whole project as a zip: text rendered from its CRDT to UTF-8, blobs
verbatim. The way to get a project out of Aeolus.

**Rate limited to 6 per minute per token** — it loads the whole project
into memory.

## Version history

Two kinds, and the difference matters:

- **Per-file checkpoints** — Aeolus keeps history **per file**, not per
  project, because each text file has its own CRDT. `fileId` selects
  which; omitted, it is the project's first text file.
- **Project checkpoints** — one label across *every* text file, plus a
  pin on the current blob set. This is the one to take before a scripted
  change that touches more than one file.

A restore is applied as a CRDT transaction against the live document and
tells any open editor to re-bootstrap, so it converges with a
collaborator rather than fighting them. A restore is itself a new
revision, so it can be undone by restoring something later.

### `GET /api/v1/docs/{id}/checkpoints?fileId=…`

Newest first. Slices belonging to a project checkpoint are excluded —
they are not free-standing history. Listing also sweeps auto-open
checkpoints older than 30 days.

```json
{ "checkpoints": [ { "id": "…", "label": "before the edit", "kind": "user",
                     "file_path": "main.tex", "created_by": "…",
                     "created_by_email": "a@b.com", "created_at": "…" } ] }
```

`kind` is `user` for one you named, `auto_open` for one the editor took
when someone opened the file.

### `POST /api/v1/docs/{id}/checkpoints?fileId=…`

Body `{ "label": "…" }` → `201`. `422 archived` on an archived document.

### `GET /api/v1/docs/{id}/checkpoints/{checkpointId}` · `GET /api/v1/docs/{id}/checkpoints/{checkpointId}/download`

The detail carries a `download_url`; the download itself is the raw
encoded CRDT snapshot as `application/octet-stream`. For readable text,
restore it and read the file's content instead.

### `POST /api/v1/docs/{id}/checkpoints/{checkpointId}/restore`

`200 { "restored": true, "rev": "…", "file_path": "…" }`.

### `GET` / `POST /api/v1/docs/{id}/project-checkpoints`

Create takes `{ "label": "…" }` and returns the files and blobs it
captured. **Rate limited to 6 per minute per token** — it snapshots every
file.

List carries `file_count` and `blob_count` per entry.

### `POST /api/v1/docs/{id}/project-checkpoints/{projectCheckpointId}/restore`

```json
{ "restored": true, "files_restored": 2,
  "files": [ { "path": "main.tex", "rev": "18" } ],
  "blobs_restored": 1, "blobs_missing": [], "blob_state_preserved": true }
```

**`blobs_missing` is the field to check.** A checkpoint can outlive its
bytes — a lifecycle rule, a bad sweep. The restore completes for
everything else rather than failing outright, and names what did not come
back.

### `DELETE /api/v1/docs/{id}/project-checkpoints/{projectCheckpointId}`

`204`. Removes the checkpoint and its file slices. Pinned objects are not
deleted here; the file-delete path frees bytes once nothing references
them.

## Administration

Admin-only. A non-admin gets `403 forbidden` whatever its token scope —
**scope and role are separate gates**, so a write-scope token minted by
an ordinary user cannot reach any of these. All four also refuse a
read-scope token minted by an admin, on the usual method rule.

### `GET /api/v1/admin/users`

Everyone, with `disabled_at`, `last_seen_at` and the timestamps.

### `PATCH /api/v1/admin/users/{id}`

Body takes `name`, `is_admin`, or both; at least one is required.

```bash
curl -sS -X PATCH https://aeolus.example.com/api/v1/admin/users/$UID \
  -H "authorization: Bearer $AEOLUS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"is_admin":true}'
```

### `POST /api/v1/admin/users/{id}/disable` · `POST /api/v1/admin/users/{id}/enable`

`204`. **This is the offboarding lever.** A disabled user is refused on
every request, which kills their browser sessions *and every API token
they minted*, immediately, without either having to be enumerated — the
bearer preHandler re-reads the user row on every call. `enable` lifts it
and the same tokens work again; nothing was revoked.

`422 self_disable` if you aim it at yourself.

### `DELETE /api/v1/admin/users/{id}`

`204`, and irreversible. Every document they own is transferred to **you**
in the same transaction; `docs.owner_id` is `RESTRICT` precisely so a
delete cannot quietly take someone's drafts with it. Their tokens,
sessions and checkpoint authorship go by cascade.

`422 self_delete` if you aim it at yourself. Prefer `disable` unless you
need the row gone.

### `GET /api/v1/admin/audit-events`

The audit log, newest first.

| Query | |
|---|---|
| `action` | exact (`doc.create`), or a **prefix** if it ends in a dot (`doc.`) |
| `actor_id` | one user |
| `before` | the `next_before` from the previous page |
| `limit` | 1–200, default 50 |

`200` →

```json
{
  "events": [
    {
      "id": "…",
      "occurred_at": "2026-09-04T21:14:02.881Z",
      "actor_id": "531c7eaa-…",
      "actor_email": "someone@example.com",
      "action": "doc.create",
      "resource_type": "doc",
      "resource_id": "0f0e1c8a-…",
      "metadata": { "via": "api_token", "token_id": "218b9e1c9f5cac45", "title": "Q3 threat report" },
      "ip": "172.23.141.9",
      "user_agent": "curl/8.5.0"
    }
  ],
  "next_before": "2026-09-04T21:14:02.881Z",
  "retention_days": 30
}
```

Two things make this the answer to "what did automation do":

- **`metadata.via`** is `api_token` for anything that came through this
  plane, alongside the `token_id`. Both planes call the same services and
  emit the same actions, so you filter by origin rather than by a separate
  vocabulary.
- **`actor_email` is captured at event time**, so the trail survives the
  account being renamed or deleted.

Pagination is a cursor on `occurred_at`, not an offset: new events landing
mid-walk cannot make a page boundary skip or repeat a row. Page until
`next_before` is `null`.

Retention is **30 days**, enforced as a side effect of reading — there is
no separate sweeper to fail silently.

## Claude-assist

### `POST /api/v1/ai/assist`

Rewrite a passage. The response is a **Server-Sent Events stream**, so read it
with an SSE client — `response.json()` will not work.

```bash
curl -sS -N https://aeolus.example.com/api/v1/ai/assist \
  -H "authorization: Bearer $AEOLUS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"doc_id":"0f0e1c8a-…","selection":"The quick brown fox.","instruction":"make it formal"}'
```

| Field | |
|---|---|
| `doc_id` | The document the selection came from. Read access required. |
| `selection` | The text to work on. 1–100,000 characters. |
| `instruction` | What to do with it. 1–2,000 characters. |
| `prefer_higher_quality` | Ask for the slower, better model. Costs more of the same quota. |
| `error_context` | A compile-error tail. Switches the prompt from *rewrite* to *fix*. Up to 16 KiB. |

Write scope. `-N` (or the equivalent) matters: a buffering client will hold the
whole stream and hand it to you at the end, which defeats the point.

### The event grammar

```
event: chunk
data: {"text":"The expeditious"}

event: chunk
data: {"text":" russet fox."}

event: usage
data: {"usage":{"input_tokens":50,"output_tokens":25,"cache_creation_input_tokens":350,"cache_read_input_tokens":0}}

event: done
data: {}
```

| `event:` | Meaning |
|---|---|
| `chunk` | A fragment of the suggestion. Concatenate in arrival order. |
| `usage` | Token counts, once, near the end. |
| `done` | Complete. Nothing follows. |
| `error` | The model failed **after** the stream opened. |

Lines beginning `:` are keepalive comments, emitted every 15 seconds so an idle
proxy does not drop a long generation. Ignore them.

### A failure arrives one of two ways

This is the part worth reading twice.

Anything checkable before the first byte — the document ACL, your quota, the
global spend cap, an unconfigured service — is an ordinary JSON status
response:

| | |
|---|---|
| `403 read_only_token` | Read-scope token. |
| `404 not_found` | No such document, or none you can read. |
| `429 quota_exceeded` | Your Claude-assist allowance is spent. Distinct from `429 rate_limited`, the plane's 120/min budget — **branch on `error`, not on the status.** A rate limit carries `retry-after`; a spent quota carries no header at all, because the answer is not "wait a moment" — read `GET /api/v1/ai/quota` and wait for the hour or the day to roll. |
| `503 ai_unavailable` | No API key configured on the server. |
| `503 quota_exceeded` | The whole deployment hit its daily spend cap. Not you. |

Once the stream is open the status line is already `200`, so a later failure
can only be an `error` event. **A client that treats `200` as success will
report a failed generation as an empty one.** Check for a `done` event, not a
status code.

### What it costs you

The quota is **per user, not per token**: every token a person mints draws down
the same hourly and daily allowance, and so does that person working in the
editor. `GET /api/v1/ai/quota` reports what is left, which is worth reading
before a batch job rather than discovering the ceiling as a stream of 429s.

Each call is written to the `ai_requests` ledger with its token cost, and
audited as `ai.assist` — the ledger answers *what did this cost*, the audit
trail answers *who asked*, and on this plane it carries `via: api_token`.

## Live collaboration

### `POST /api/v1/ws/ticket`

A short-lived, document-bound ticket admitting you to the Yjs collaboration
WebSocket.

```bash
curl -sS -X POST https://aeolus.example.com/api/v1/ws/ticket \
  -H "authorization: Bearer $AEOLUS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"doc_id":"0f0e1c8a-…"}'
```

`201` →

```json
{
  "ticket": "y3Jf…",
  "doc_id": "0f0e1c8a-…",
  "expires_at": "2026-09-04T22:19:02.881Z"
}
```

Pass it as `?ticket=…` on the `wss://` upgrade URL. Valid five minutes and
multi-use within that window; re-mint around reconnects rather than holding one
open.

**You probably do not need this.** To read or write a file, use
`GET`/`PUT /docs/{id}/files/{fileId}/content` — those are the operations this
API is shaped for, and they apply an edit as a Yjs transaction against the live
document anyway, so a collaborator mid-edit stays coherent. The socket is for
speaking Yjs: live co-editing, cursors, presence.

**What a ticket is not.** Once redeemed you are outside this plane. The socket
has no scope gate, no rate limit, and does not audit edits one by one. That is
why minting one requires a **write-scope** token even though it grants no more
than the document ACL already allows: a read-scope token must not be able to
reach a channel that cannot enforce its scope. Every mint is audited as
`ws.ticket.mint`.

## Managing tokens

Token management is **not** on this plane. `GET`/`POST /api/tokens` and
`DELETE /api/tokens/:id` are session-gated browser routes, reachable
only with a signed-in session, and are driven by the `/tokens` page.

That is deliberate: a write-scope token that could mint tokens would be
able to outlive its own revocation by creating a successor.

## Machine-readable description

```
https://aeolus.example.com/api/v1/openapi.json   OpenAPI 3.1
https://aeolus.example.com/api/v1/openapi.yaml   the same, as YAML
https://aeolus.example.com/api/v1/reference      a browsable reference
```

All three need **no credential** — requiring a token to read the document
that explains how to get one is a bootstrap loop.

The description is generated from the same schemas the routes validate
and serialize with, so it cannot describe something the API does not do.
A route that ships without a summary, tags and documented responses
**fails the app's boot**, so "documented" is enforced rather than
remembered. Point a client generator at `openapi.json` and the result
will match what the server actually returns.

A copy is committed at `docs/openapi.json` and a CI job fails the build
if it drifts — which also means any change to the wire format shows up
as a reviewable diff on the pull request.

## Not yet

Every domain operation the UI can perform is here: identity, documents, files
and content, templates, compilation, version history, administration,
Claude-assist and the collaboration ticket.

What is left out is left out **on purpose**, not pending:

- **Token management.** `GET`/`POST /api/tokens` and `DELETE /api/tokens/{id}`
  stay session-gated, for the reason above.
- **`/api/admin/diagnostics`.** An operator's live view of the compile queue
  and the WebSocket process. It works by forwarding the caller's *session
  cookie* to the ws host — there is no cookie on this plane, so half of it
  would always be blank. It is a debugging page, not an interface.
- **Session mechanics** — sign-in (`POST /api/auth/login`), passphrase setup
  and change (`POST /api/auth/passphrase`), sign-out
  (`DELETE /api/me/session`). All three are browser routes. A token has no
  session to end; revoke it at `/tokens` instead.
- **Credential administration** — `POST /api/admin/users` and
  `POST /api/admin/users/{id}/reset-passphrase` each return a one-time
  generated passphrase. They stay session-gated for the same reason token
  management does: a token that could issue credentials could outlive its own
  revocation.

## Changelog

- **2026-09-13** — Fastify's own error codes no longer leak: a body over
  the limit is `413 payload_too_large`, a wrong content-type is
  `415 unsupported_media_type` (both previously surfaced as `FST_ERR_*`
  strings, and on this plane as a 500). The `/files/upload` error
  responses now declare the `{ error, message }` envelope instead of an
  empty object schema. No successful response changed.
- **2026-09-04** — `v1` opens: bearer tokens, scope gate, rate limiting,
  `GET /api/v1/me`, and the generated OpenAPI 3.1 description with its
  browsable reference. Documents follow the same day: full CRUD, archive
  and collaborator management, plus `GET /docs/{id}/collaborators`, which
  the UI plane never had. Then the file tree, including reading and
  writing text content over HTTP for the first time.
  Templates, compilation with its artifacts, and version history complete
  the document lifecycle. Identity and administration close it out:
  `PATCH /me`, the assist quota, user management including the disable
  lever, and the audit log — where `metadata.via` separates what
  automation did from what a person did.
  Claude-assist and the collaboration ticket close it out — the plane now
  reaches everything the UI does. Assist is the one streaming operation, and
  the one where a failure can arrive as an event rather than a status.
- **2026-09-12** — `warnings: string[]` on `GET /compile/{jobId}` and
  `GET /compile/latest` (#102): non-fatal findings on a successful
  compile, today a font the PDF references but does not embed. Empty
  when clean.
