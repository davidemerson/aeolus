# Add a LaTeX package to the compile worker image

**When to use this.** Per ADR 0011, the compile worker is **not**
network-isolated — Tectonic pulls packages on demand from the
public TeX Live bundle relay and caches them in
`/opt/tectonic-cache`. Most packages "just work" the first time a
doc references them. You only need this runbook in two cases:

1. A package must be available on the **very first compile after
   a deploy** (cold-task latency matters), or
2. We're moving to a private S3-backed bundle (followup in ADR
   0011) and need to vendor the superset.

If a one-off compile failed only because the relay was unreachable
or rate-limited, retrying later is the right move; nothing here
changes the runtime behaviour.

### User-uploaded fonts

`apps/compile-worker/src/runner.ts` sets `OSFONTDIR=<workdir>` so
fontspec / XeTeX can find any `.otf` / `.ttf` the user uploaded
to the doc. After upload, `\setmainfont{Foo.otf}` resolves to the
file in the workdir (no `Path=` option needed). MIME allowlist for
upload includes both extensions; see `apps/api/src/routes/assets.ts`'s
`EXT_TO_MIME`.

**Prerequisites.**

- Local clone of `aeolus` with Docker available. The compose stack
  builds `Dockerfile.worker` itself (`docker-compose.yml`, service
  `worker`), so on a self-hosted install there is no registry in the
  loop — you rebuild the image in place.
- Tectonic `0.15.0` binary locally if you want to rehearse before
  editing the Dockerfile (`ARG TECTONIC_VERSION=0.15.0` in
  `Dockerfile.worker`).

## 1. Reproduce the failure offline

1. Check `compile_results.error` for the failing job to get the exact
   file name Tectonic complained about.
2. Locally, run the worker's compiler against the failing document
   with `TECTONIC_CACHE_DIR` pointed at an empty directory to confirm
   the missing file is in Tectonic's default TeX Live bundle and not
   something we'd need to vendor ourselves:

   ```bash
   mkdir -p /tmp/tec-probe
   TECTONIC_CACHE_DIR=/tmp/tec-probe \
     tectonic -X compile --outfmt pdf /path/to/repro.tex
   ```

   If Tectonic succeeds locally (with network access), the package is
   in the bundle and only needs to be warmed into the image cache. If
   Tectonic fails locally too, the package is not in the bundle —
   stop here and open an issue; we do not ship non-bundle packages in
   this phase.

## 2. Extend the warm-up document

The cache is populated by a single warm-up step in
`Dockerfile.worker` (repo root):

```dockerfile
RUN set -eux; \
    WARMDIR="$(mktemp -d)"; \
    printf '%s\n' \
        '\documentclass{article}' \
        '\usepackage[utf8]{inputenc}' \
        '\usepackage{amsmath}' \
        '\begin{document}' \
        'Hello, \emph{world}! $a^2 + b^2 = c^2$' \
        '\end{document}' \
        > "$WARMDIR/warmup.tex"; \
    (cd "$WARMDIR" && tectonic -X compile --outfmt pdf warmup.tex >/dev/null); \
    rm -rf "$WARMDIR"; \
    chown -R compiler:compiler /opt/tectonic-cache
```

1. Add a `\usepackage{<new-package>}` line inside the `printf` block,
   keeping the trailing `\\` per line.
2. If the package needs a short exercise to pull secondary
   dependencies (e.g. `tikz` pulls several `.sty` files only when
   actually invoked), add a minimal use of the package inside the
   `\begin{document}...\end{document}` block — one figure / one
   table is plenty.
3. Do not split the warm-up into multiple `RUN` invocations; a
   single layer keeps the cache directory consistent and the image
   smaller.

## 3. Rebuild and smoke-test the image

From the repo root:

```bash
docker build -f Dockerfile.worker -t aeolus-compile-worker:warmup-probe .
```

The build is fully offline after the initial apt + download steps; if
the warm-up compile fails, the image build fails and you see the
Tectonic error in the build output. Fix the warm-up document and
retry.

Once the image builds, verify the new package is actually cached:

```bash
docker run --rm --entrypoint bash aeolus-compile-worker:warmup-probe -c '
  cat > /tmp/probe.tex <<EOF
  \documentclass{article}
  \usepackage{<new-package>}
  \begin{document}test\end{document}
EOF
  tectonic -X compile --outdir /tmp --outfmt pdf /tmp/probe.tex
'
```

The probe must succeed with **no network access** — run the local
`docker run` with `--network=none` so a missed dependency surfaces
here as `error sending request for url` rather than silently
fetching at runtime. (The running worker container is *not* network
-isolated — per ADR 0011 it is allowed to reach the relay; this
`--network=none` is a build-time check only.)

## 4. Run the compile integration tests

```bash
AEOLUS_TECTONIC_BIN=$(which tectonic) \
AEOLUS_TYPST_BIN=$(which typst) \
AEOLUS_TECTONIC_CACHE_DIR=/tmp/aeolus-tectonic-cache \
pnpm --filter @aeolus/tests-integration test compile.latex
```

Both `compile.latex.test.ts` and `compile.typst.test.ts` must stay
green — they are the canonical regression test for the compile
pipeline and are part of the phase-09 acceptance criteria in
`docs/TEST_PLAN.md`.

## 5. Commit + roll the worker

Commit the Dockerfile change as a single commit on `main`:

```
build: pre-warm <new-package> in compile-worker image
```

On your own instance, rebuild and replace the running worker. Nothing
else needs restarting — the worker takes jobs off the Postgres queue,
so a replacement picks up where the old one left off:

```bash
docker compose build worker
docker compose up -d worker
```

The cache is baked into the image, so it is warm from the container's
first compile.

## Verification

- `compile_results` rows for the previously-failing document now
  transition `queued → running → success`, the PDF renders in the
  editor's preview pane, and
  `GET /api/docs/:id/compile/:jobId/download` streams it.
- No regression in `compile.latex.test.ts` / `compile.typst.test.ts`.
- The new compile worker image size is within ~10% of the previous
  image (large jumps — e.g. adding TikZ — are expected and worth
  noting in the commit body, but anything larger than +50 MB should
  be investigated).
