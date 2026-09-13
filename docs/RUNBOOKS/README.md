# Runbooks

Operational playbooks for running Aeolus. Each runbook
should be short enough to execute under pressure and detailed
enough that someone who didn't write it can follow it.

Aeolus is self-hosted: the deployment these runbooks assume is the
`docker compose` stack at the repository root (`docker-compose.yml`,
configured by `.env` — see `.env.example`).

## Index

| Runbook | Purpose |
| --- | --- |
| `api-tokens.md` | Grant, revoke and triage `/api/v1` bearer tokens. Granting is self-service — this says why, and how to tell which gate refused a call. |
| `add-latex-package.md` | Bake a new LaTeX package into the compile worker image. |
| `electron-build.md` | How to build and ship the Electron installers. |
| `tectonic-bundle.md` | Point the worker at a Tectonic bundle you host, instead of the public relay. |

## Conventions

- Every runbook opens with **When to use this** and **Prerequisites**.
- Steps are numbered, idempotent, and copy-pasteable.
- Every runbook ends with a **Verification** section describing how
  to confirm success.
- Destructive steps are flagged with `⚠` and require a second pair
  of eyes.
