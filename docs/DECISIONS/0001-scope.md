# 0001 — Scope + locked architecture decisions

- **Status**: accepted — amended 2026-09-13 for the public release: authentication is a local email + passphrase ([`0026`](0026-local-passphrase-authentication.md)) and the deployment shape is the bundled compose stack ([`0027`](0027-single-origin-compose-topology.md)). The rows those two replace are marked in the table.
- **Date**: 2026-04-14
- **Deciders**: davidemerson

## Context

Aeolus is a minimalist alternative to Overleaf: a collaborative
LaTeX/Typst editor an operator runs on their own hardware, with
admin-maintained templates and a live PDF preview.

This ADR locks the foundational decisions so later phases don't have to
re-litigate them. Everything below the table is still the shape of the
application; only the two rows marked *amended* changed when the project
was published.

## Decision

| Area | Choice |
| --- | --- |
| Access model | No public self-signup. An administrator creates every account. *(amended: originally an invite flow behind a private network overlay)* |
| Auth | Email + passphrase, verified locally against a scrypt hash — see [`0026`](0026-local-passphrase-authentication.md). *(amended: originally WebAuthn passkeys)* |
| Collaboration | Yjs CRDT over WebSocket, persisted to Postgres. |
| LaTeX engine | Tectonic only; Typst as a co-equal second engine. |
| Hosting | Six containers in one `docker-compose.yml`: `api`, `ws`, `worker`, Postgres, MinIO, Caddy — see [`0027`](0027-single-origin-compose-topology.md). *(amended: originally a managed container platform)* |
| Ingress | One origin. Caddy routes `/ws` to the ws process and everything else to the api. |
| Electron | Thin wrapper around the hosted webapp (no offline mode at v1). |
| Claude-assist | One instance-wide Anthropic key, a per-user request quota, and a daily spend cap. |
| v1 features | Live PDF preview, asset uploads, version history, Claude-assist. |

## Consequences

- Accounts do not create themselves. The first launch bootstraps one
  administrator with a generated passphrase printed to the api's log
  (`apps/api/src/bin/server.ts`); every later account is created from
  `/admin/users`.
- The Tectonic cache is pre-warmed inside the compile-worker image; a
  package outside the warm set is fetched on first use. See
  [`0011`](0011-latex-package-cache.md) and
  `docs/RUNBOOKS/add-latex-package.md`.
- Claude-assist is optional. With no `ANTHROPIC_API_KEY` the feature is
  absent rather than broken.

## Alternatives considered

- **Public internet + self-signup.** Rejected: an operator running this
  for a research group or a company wants to decide who has an account,
  and a self-signup form on a document editor is an invitation to abuse
  the compile worker.
- **Operational Transform instead of CRDT.** Rejected: fewer modern
  libraries, more operationally fragile than Yjs.
- **Per-user Anthropic API keys.** Rejected: one billing identity per
  instance with server-side per-user quotas is simpler to run and is the
  only shape that can enforce an instance-wide spend cap.
- **A single host running docker compose.** Rejected at the time in
  favour of a managed container platform. That judgement is reversed for
  the published project: compose *is* the shipped topology, and
  [`0027`](0027-single-origin-compose-topology.md) records why the shape
  it takes is not negotiable.
