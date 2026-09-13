# Pin the compile worker to a Tectonic bundle you host

**When to use this.** Issue #11 / ADR 0011 option 3. The compile
worker normally pulls packages from the public Tectonic relay
(`https://relay.fullyjustified.net/`) on demand. To remove the
runtime dependency on a host you don't control, mirror a pinned
Tectonic bundle somewhere you do — object storage, a static web
server, a file in the image — and point the worker at it with the
`AEOLUS_TECTONIC_BUNDLE` environment variable.

You want this when one of:

- The relay has been flaky and compiles are failing.
- You need an air-gapped guarantee for a security review.
- You are running more than one worker and the repeated egress
  is worth removing.

The runtime code path is already wired: `AEOLUS_TECTONIC_BUNDLE` is
read in `apps/compile-worker/src/bin/worker.ts`, passed as
`tectonicBundle` through `worker.ts`, and turned into
`tectonic -X compile --bundle <value>` by `buildTectonicArgs` in
`runner.ts`. The work below is one-time operator setup.

## Prerequisites

- The compose stack from the repository root, and the `.env` it reads
  (`.env.example` documents `AEOLUS_TECTONIC_BUNDLE`, commented out).
- Somewhere to serve the tar from that the worker container can reach
  over HTTPS. The stack already runs MinIO for document blobs, but that
  bucket is not public — anything that answers a plain `GET` works, and
  a local path works too, with the caveat under *Local paths and the
  sandbox* below.
- `curl`, to fetch the upstream bundle tar.
- The Tectonic version the worker image bakes, so the bundle you pin is
  one that version reads: `ARG TECTONIC_VERSION=0.15.0` in
  `Dockerfile.worker`.

---

## Step 1 — Pick a Tectonic bundle version

Tectonic ships pinned bundle URLs you can copy verbatim. As of
Tectonic 0.15 the canonical mirror is:

```
https://relay.fullyjustified.net/default_bundle_v0_3.tar
```

Pin to a specific URL by snapshotting the tar. The actual filename
changes when Tectonic upstream rolls a new bundle; check
`tectonic --version` for the version your worker image bakes.

You can also generate a custom bundle from a TeX Live source
checkout (`tectonic bundle <texlive>`) — out of scope here; do
that only when you need packages the upstream bundle doesn't
include.

## Step 2 — Mirror the tar somewhere you control

```sh
curl -fL https://relay.fullyjustified.net/default_bundle_v0_3.tar \
  -o /tmp/tectonic-bundle.tar
```

Then publish `/tmp/tectonic-bundle.tar` at a stable URL on your own
infrastructure. Keep the version in the object name
(`default_v0_3.tar`) rather than overwriting one key, so a rollback is
a change of one line rather than a re-upload.

Nothing about the bundle is secret — it is a public TeX Live snapshot —
so it does not need credentials, and putting it behind an authenticated
URL means the worker cannot fetch it.

## Step 3 — Set AEOLUS_TECTONIC_BUNDLE

In `.env` at the repository root:

```sh
AEOLUS_TECTONIC_BUNDLE=https://files.example.com/tectonic/default_v0_3.tar
```

Then recreate the worker so it picks the value up. Only the worker
reads it:

```sh
docker compose up -d worker
```

### Local paths and the sandbox

`--bundle` also accepts a local file path, and the worker passes one
through unchanged. But with `AEOLUS_SANDBOX_MODE=enforce` the Landlock
wrapper grants the engine read access only to the workdir, the Tectonic
cache, the engine binary and `/usr`, `/lib`, `/lib64`, `/etc/ssl`,
`/etc/fonts`, `/etc/resolv.conf`, `/dev/urandom`, `/dev/null`
(`buildSandboxArgv` in `apps/compile-worker/src/runner.ts`). A bundle
anywhere else is denied and every compile fails. Bake the tar under
`/usr` in `Dockerfile.worker` if you want a local one, or serve it over
HTTPS.

## Step 4 — Verify

On startup the worker writes one line naming the bundle:

```sh
docker compose logs worker | grep -i bundle
```

```
[compile-worker] using pinned Tectonic bundle: https://...
```

Then trigger a compile — admin → diagnostics → **Smoke compile**, or
`POST /api/admin/diagnostics/compile` — and confirm it succeeds. The
first compile against a fresh bundle reads the tar from your host and
caches its contents in `/opt/tectonic-cache`, exactly as it would have
from the public relay. Later compiles in the same container hit the
cache; a replacement container fetches from your host, not the relay.

## Refresh

Tectonic bundle snapshots don't change frequently, but when a
package the warmup doc doesn't cover gets newly required, you may
want to re-snapshot from the latest upstream:

```sh
curl -fL https://relay.fullyjustified.net/default_bundle_v0_4.tar \
  -o /tmp/tectonic-bundle.tar
```

Publish it beside the old one, point `AEOLUS_TECTONIC_BUNDLE` at the
new URL, and `docker compose up -d worker`. Keep the previous version
served for at least one cycle in case you need to roll back.

## Reverting

Clear the variable to fall back to the public relay:

```sh
# comment out or empty AEOLUS_TECTONIC_BUNDLE in .env, then
docker compose up -d worker
```

The empty string is treated as unset by the worker entrypoint
(`--bundle` is only added when the value is truthy).

## References

- Issue #11 — pin Tectonic to a self-hosted bundle
- ADR 0011 — LaTeX package cache strategy (option 3)
- `apps/compile-worker/src/runner.ts` — `--bundle` plumbing and the
  sandbox's read-only allow-list
- `apps/compile-worker/src/bin/worker.ts` — `AEOLUS_TECTONIC_BUNDLE`
  pass-through and the startup log line
- `.env.example` — where the variable is documented for operators
