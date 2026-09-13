# 0012 — LaTeX engine selection: keep Tectonic as default, add a separate TeX Live worker for opt-in engines

- **Status**: accepted, **not yet implemented** — as of 2026-09-13 there
  is no `latex_engine` column, no second worker image and no engine
  picker. `docs.engine` is still `'latex' | 'typst'` and `'latex'` still
  means Tectonic. The decision below stands; the plan is a plan.
- **Date**: 2026-05-01
- **Deciders**: davidemerson

## Context

`docs.engine` is `'latex' | 'typst'` (a check constraint in
`packages/db/src/schema.ts`). The `'latex'` value always resolves to
**Tectonic**: XeTeX-flavoured, bundle-based, a single ~85 MB binary, no
system TeX Live. Issue #6 asked for `pdflatex`, `xelatex` and
`lualatex` as selectable engines.

Tectonic is already XeTeX-derived, so `xelatex` is mostly redundant.
`pdflatex` is genuinely different: an 8-bit engine that some packages
require (notably PSTricks-based diagrams and certain bibliography
backends), compiling via DVI → PS → PDF rather than direct PDF output.
`lualatex` is the modern Unicode-capable engine that `fontspec` and
advanced microtype features prefer, and the direction TeX Live is
leaning.

A document needs a way to say "compile me with pdflatex" that routes to
the right binary, without making the no-config default pay for TeX
Live's footprint.

## Options considered

### Option A — Keep Tectonic, add a TeX Live worker variant

- Add `latex_engine` on `docs`:
  `'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex'`, default
  `'tectonic'`. `engine` stays `'latex' | 'typst'`.
- The existing `aeolus-worker` image (Tectonic + Typst) keeps handling
  `latex_engine='tectonic'` and `engine='typst'`.
- A new `aeolus-worker-texlive` image (~3 GB, from the official
  `texlive/texlive` Debian image) handles the other three, running as a
  second service so an install that never selects them never pays for
  it.
- Dispatch: the pg-boss queue `aeolus.compile` carries `latex_engine`,
  and each worker handles only the engines it has.

Pros: Tectonic stays the default — small image, fast start, low memory.
TeX Live is maintained upstream, so there are no per-package patches to
curate. A TeX Live regression cannot break the default compile path.

Cons: two worker images to build. A cold TeX Live compile is slower than
a warm Tectonic one — TeX Live has no equivalent of the bundle pre-fetch
[`0011`](0011-latex-package-cache.md) exploits, so warming means
`tlmgr install`.

### Option B — Replace Tectonic with TeX Live

Single ~3 GB image dispatching by `latex_engine` to the matching binary.

Pros: one image, one mental model, and an exhaustive package set with no
"Tectonic doesn't have X" surprises.

Cons: every install pays 3 GB and a slower cold start, even for a
one-page document. The pre-warmed Tectonic cache from
[`0011`](0011-latex-package-cache.md) is lost. A TeX Live regression
breaks every compile path rather than one.

## Decision

**Option A — keep Tectonic as the default and add a separate TeX Live
worker for opt-in engines.**

The Tectonic path is well tested and small; replacing it with a 3 GB
image punishes the common case. Splitting the workload keeps the default
fast and lets an operator run the heavy worker only if anyone asks for
it.

## Implementation plan

Each phase ships behind the previous phase's default.

### Phase 1 — schema + API + UI scaffold (no new image)

1. Migration adding `latex_engine text NOT NULL DEFAULT 'tectonic'`
   with a check constraint over the four values. Existing rows take the
   default.
2. `packages/db/src/schema.ts` mirrors the column.
3. `apps/api` accepts `latex_engine` on doc create and rejects anything
   but `'tectonic'` for now — the worker cannot honour the rest yet, and
   the API should fail loudly rather than silently misroute.
4. `apps/web`'s doc-create dialog gains an engine picker showing only
   `'tectonic'` until phase 3.
5. The compile worker reads `latex_engine` from the job payload and
   fails anything else with a clear `engine_not_supported`, so a
   mistargeted write is visible during the migration.

### Phase 2 — TeX Live worker image

1. `Dockerfile.worker-texlive`, based on `texlive/texlive:latest-medium`
   (or `:basic`, if it carries the packages the default template needs
   — verify before choosing).
2. A second compose service running that image against the same
   `aeolus.compile` queue, scaled to zero until phase 3.
3. Engine dispatch factored into a single switch on `latex_engine`.
   Both images ship the same code; the environment decides which
   engines the running container accepts.

### Phase 3 — flip the picker

1. The UI picker accepts all four values.
2. Each worker takes only jobs whose engine it has. pg-boss has no
   native conditional consume, so this needs either a per-engine queue
   name or a deliberate release-back path — settle which before
   merging, because a worker that acks a job it cannot run loses it.
3. Bring the TeX Live service up.

### Phase 4 — clean up

1. Drop the phase-1 `engine_not_supported` early-fail.
2. Document the `tlmgr install` workflow for the TeX Live image,
   alongside `docs/RUNBOOKS/add-latex-package.md`.

## Out of scope

- Bibliography backend selection (`biber` vs `bibtex`) — every engine
  ships both.
- Per-engine timeout tuning. The current wall clock is
  `DEFAULT_TIMEOUT_MS = 30_000` in
  `apps/compile-worker/src/runner.ts`; revisit once there are real TeX
  Live timings to look at.
- Engine conversion on fork. A fork preserves the source's
  `latex_engine`; the TeX flavours are not source-compatible without
  manual fixes.

## References

- Issue #6 — feat: multiple LaTeX engines
- [`0011`](0011-latex-package-cache.md) — LaTeX package cache strategy
