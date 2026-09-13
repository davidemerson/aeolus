# 0011 — LaTeX package cache strategy: pre-warm the image, don't network-isolate

- **Status**: accepted — re-grounded 2026-09-13 for a self-hosted
  install; the decision (warm the image, let Tectonic fetch the rest) is
  unchanged, and option 3 is now shipped as an opt-in.
- **Date**: 2026-04-30
- **Deciders**: davidemerson

## Context

Tectonic compiles LaTeX by pulling individual `.sty` / `.cls` / font /
encoding files on demand from a CTAN-mirrored "TeX Live bundle", by
default the public relay at `https://relay.fullyjustified.net/`. The
first time a document references a package Tectonic downloads it; later
compiles hit the cache directory.

`Dockerfile.worker` sets `TECTONIC_CACHE_DIR=/opt/tectonic-cache` **and**
`XDG_CACHE_HOME=/opt/tectonic-cache` — Tectonic 0.15 splits its cache
between the two depending on whether it is fetching a bundle file or a
format file, so setting only the first leaves half the cache somewhere
else. The image is warmed at build time by compiling a document that
pulls `graphicx`, `hyperref`, `xcolor`, `booktabs`, `geometry`,
`fancyhdr`, `enumitem`, `titlesec`, `listings`, `fontspec`, `amsthm`,
`amssymb` and `csquotes`. The warmup runs as the runtime `compiler`
user, not as root, so the cache files are owned by the account that will
later extend them.

The question this ADR answers: how do packages a user references get
into the cache, and do they persist?

- **Across documents in the same container.** Yes. A package downloaded
  by one compile is reused by the next.
- **Across container recreations.** No, unless a volume is mounted at
  the cache path. A recreated container starts from the warm set baked
  into the image plus whatever it downloads.
- **Across multiple workers.** Each has its own cache and re-downloads
  anything outside the warm set.

## Options considered

1. **Warm at build, supplement on demand.** Free, no architecture
   change. A cold compile after a recreation pays a few seconds of
   download for a document using uncommon packages.
2. **A shared network filesystem for the cache.** Persistent across
   recreations and workers. Adds an availability dependency to compile,
   for a cache.
3. **A bundle the operator hosts.** Mirror a pinned Tectonic bundle to
   object storage, a static web server, or a file in the image, and
   point `AEOLUS_TECTONIC_BUNDLE` at it. Compiles never touch a host the
   operator does not control.
4. **Full network isolation with a complete bundle in the image.** Bake
   every conceivable package in. The image grows to roughly 2 GB and
   adding a package means a rebuild.

## Decision

**Option 1 is the default**, with the build-time warmup covering the
packages a normal document actually uses, so a cold compile after a
restart is not a download.

This is the right default because a typical install is a handful of
authors compiling a few times an hour; the egress is negligible, and a
package a user wants "just works" the first time they reference it
rather than requiring an image rebuild. `Dockerfile.worker` only needs
editing when a package must be fast on the *very first* compile.

**Option 3 ships as an opt-in.** `AEOLUS_TECTONIC_BUNDLE` is read in
`apps/compile-worker/src/bin/worker.ts` and becomes
`tectonic -X compile --bundle <value>`; the worker logs which bundle it
is using at boot. `docs/RUNBOOKS/tectonic-bundle.md` is the operator
procedure. This is the answer for an air-gapped install, a flaky relay,
or more than one worker.

Option 2 is overkill for a cache. Option 4 trades a 2 GB image for a
problem option 3 solves better.

## Consequences

- Compiling requires outbound HTTPS to the bundle host unless
  `AEOLUS_TECTONIC_BUNDLE` points somewhere local. An install with no
  egress must use option 3; that is the one configuration where this
  decision is not optional.
- **The compose stack does not currently persist the cache.**
  `docker-compose.yml` declares a `tectonic-cache` volume and mounts it
  at `/home/worker/.cache/Tectonic`, but the worker container runs as
  `compiler` (home `/home/compiler`) and its cache lives at
  `/opt/tectonic-cache`. Nothing reads or writes the mounted path, so
  the volume is inert and a `docker compose up --build` starts from the
  image's warm set every time. Mounting the volume at
  `/opt/tectonic-cache` is what the comment beside it intends.
- `docs/RUNBOOKS/add-latex-package.md` is the procedure for extending
  the warm set. Most packages need nothing.
