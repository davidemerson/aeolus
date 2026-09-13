# Architecture decision records

One file per decision, numbered in the order they were made. To add one, copy the header block of [`0022`](0022-sandbox-compile-engine-with-landlock.md) (`# NNNN — Title`, then `Status` / `Date` / `Deciders` / `Supersedes/relates` bullets), number it highest-existing + 1, and add a row below.

Status is read from each file's header, including amendment and retirement notes. A superseded ADR stays in place and says what replaced it.

## Why some numbers are missing

**0007, 0008, 0009 and 0017 do not exist.** Aeolus was built inside one organisation before it was published, and those four records were about that organisation's deployment environment — its cloud accounts, its internal deploy pipeline, the private network overlay the app sat behind, and the internal hostname it answered on. None of it exists in the published project and none of it would mean anything to someone running Aeolus themselves, so the files were removed at publication rather than rewritten into fiction.

The remaining records keep the numbers they were assigned. Renumbering would break every cross-reference in this directory and in the source, and would quietly rewrite the order decisions were actually made in. A gap is cheaper and more honest than that.

Where a surviving record's *reasoning* leaned on that environment, the reasoning has been re-grounded in what is true for a self-hosted install and the change is marked in the record's `Status` line. Two decisions made during the fork itself — local passphrase authentication, and the single-origin compose topology — were not written down anywhere, and are now [`0026`](0026-local-passphrase-authentication.md) and [`0027`](0027-single-origin-compose-topology.md).

**The migration history was squashed at publication too.** `packages/db/migrations/` starts from a single `0000_initial.sql` that creates the schema as it stands. Records below sometimes describe a schema change as a discrete step — a table dropped, a column re-targeted — because that is how it happened; those steps are folded into the one initial migration and there is no per-step file to go and read.

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-scope.md) | Scope + locked architecture decisions | accepted — amended 2026-09-13: the Auth and Hosting rows are now 0026 and 0027 | 2026-04-14 |
| [0002](0002-drizzle-orm.md) | Drizzle ORM for Postgres access | accepted | 2026-04-14 |
| [0003](0003-acl-404-vs-403.md) | Return 404 (not 403) for unauthorized document reads | accepted — scope narrowed by 0018 (legitimately absent sub-resources answer 204) | 2026-04-14 |
| [0004](0004-e2e-testcontainers-over-compose.md) | E2E stack orchestration: testcontainers + in-process servers, not docker compose | accepted — amended 2026-09-13: Redis is gone, and the compose file is now the shipped deployment | 2026-04-14 |
| [0005](0005-prompt-caching.md) | Prompt caching for Claude-assist | accepted | 2026-04-15 |
| [0006](0006-electron-signing-deferred.md) | Electron builds ship unsigned | accepted | 2026-04-15 |
| [0010](0010-postgres-least-privilege-migrator.md) | Postgres least-privilege migrator and TLS handling | accepted — TLS section rewritten 2026-09-13 around `AEOLUS_DB_SSL` | 2026-04-30 |
| [0011](0011-latex-package-cache.md) | LaTeX package cache strategy: pre-warm the image, don't network-isolate | accepted — re-grounded 2026-09-13; option 3 ships as `AEOLUS_TECTONIC_BUNDLE` | 2026-04-30 |
| [0012](0012-latex-engine-selection.md) | LaTeX engine selection: keep Tectonic as default, add a separate TeX Live worker for opt-in engines | accepted, **not yet implemented** — no `latex_engine` column and no second worker image exist | 2026-05-01 |
| [0013](0013-per-file-yjs-persistence.md) | Per-file Yjs persistence: re-target the FK from `docs` to `doc_files` | accepted — phase-4 cleanup done (`doc_assets` dropped; blobs live in `doc_files`) | 2026-05-01 |
| [0014](0014-inline-comments.md) | Inline comments: Yjs-native storage, no new tables | accepted | 2026-05-01 |
| [0015](0015-audit-log.md) | Audit log: in-DB, 30-day retention, sweep-on-read | accepted — action list re-stated 2026-09-13 against the current `AuditAction` union | 2026-05-01 |
| [0016](0016-invite-management-rotate-on-copy.md) | Invitation management: rotate-on-copy, merged into /admin/users | **superseded by 0026** — the `invitations` table is gone; an admin now creates the account directly | 2026-05-02 |
| [0018](0018-204-for-absent-subresources.md) | 204, not 404, for a sub-resource that is legitimately absent | accepted — narrows 0003 | 2026-08-13 |
| [0019](0019-machine-api-plane.md) | A versioned `/api/v1` machine plane, alongside the browser plane | accepted — companion of 0020 | 2026-09-04 |
| [0020](0020-self-service-api-tokens.md) | Self-service API tokens, minted in the UI | accepted — companion of 0019 | 2026-09-04 |
| [0021](0021-service-layer-extraction.md) | A service layer, extracted one domain at a time | accepted — enforced 2026-09-13: no route module writes to a table directly | 2026-09-04 |
| [0022](0022-sandbox-compile-engine-with-landlock.md) | Sandbox the compile engine's filesystem with Landlock | accepted — the image ships `audit`; enforcing is the operator's flip | 2026-09-06 |
| [0023](0023-collaborator-identity-in-awareness.md) | Collaborator identity in awareness: name from the session, colour from the user id | accepted | 2026-09-12 |
| [0024](0024-fail-fast-env-and-readiness.md) | Required configuration fails the boot; readiness is a separate probe | accepted — variable list and shutdown numbers re-checked 2026-09-13 | 2026-09-13 |
| [0025](0025-browser-plane-edge-hardening.md) | Security headers, a report-only CSP, and rate limits on the browser plane | accepted — re-checked 2026-09-13 | 2026-09-13 |
| [0026](0026-local-passphrase-authentication.md) | Authenticate locally with an email and a passphrase | accepted — supersedes 0016; amends 0001 | 2026-09-13 |
| [0027](0027-single-origin-compose-topology.md) | One origin in front of everything, and a shared blob store that is not optional | accepted — amends 0001 | 2026-09-13 |
