# 0022 — Sandbox the compile engine's filesystem with Landlock

- **Status**: accepted — the image ships `audit` mode; enforcing is the
  operator's flip, for the reason in "Rollout" below.
- **Date**: 2026-09-06
- **Deciders**: David Emerson
- **Supersedes/relates**: [`0011`](0011-latex-package-cache.md) (worker
  network posture); [`0012`](0012-latex-engine-selection.md) (engine
  selection)

## Context

The compile worker runs Tectonic (LaTeX) and Typst against
**attacker-controlled document source**. Any account on the instance can
create a document and put arbitrary LaTeX in it.

**Tectonic has no filesystem sandbox.** `\input{...}` — and `\include`,
`\openin`, `\InputIfFileExists` — reads whatever path the source names,
relative or absolute, with no confinement. Confirmed against the worker
image on 2026-09-05: `\input{/etc/passwd}`,
`\input{../../../../etc/passwd}` and `\input{/proc/self/environ}` were
all **read** (each then failed on TeX *syntax* partway into the file,
which is proof the file was opened rather than merely searched for). The
content renders into the PDF the caller downloads, so **exfiltration
needs no network**.

`runner.ts`'s `safe()` rejects `../` in *stored asset paths* — but the
LaTeX source is opaque to it, so that check does nothing here.
Tectonic's own `--untrusted` / `TECTONIC_UNTRUSTED_MODE` gates
*shell-escape*, not file paths. Typst is **not affected**: its `read` and
`include` resolve within the project root and cannot escape it.

**Blast radius.** Everything in the worker process's environment is
readable through `/proc/<worker-pid>/environ` by anything running as the
same uid, which the engine does. That is `DATABASE_URL` and the object
store's credentials. The compose stack deliberately does **not** put
`AEOLUS_COOKIE_SECRET` in the worker's environment — the worker never
reads it, and a secret that is not there cannot be read out of `/proc`.
Anyone assembling their own deployment should keep that property.

## Decision

**Confine the engine's filesystem with Landlock.** A small C helper,
`apps/compile-worker/native/aeolus-sandbox.c`, applies a Landlock
ruleset and then `execve`s the engine. Landlock rules are inherited
across exec, so the engine and anything it spawns can touch only the
allow-listed paths. `buildSandboxArgv` in
`apps/compile-worker/src/runner.ts` builds the argument list:

- **read-write**: the per-compile workdir, and the Tectonic cache dir
  when one is configured;
- **read-only**: the engine binary, plus `/usr`, `/lib`, `/lib64`,
  `/etc/ssl`, `/etc/fonts`, `/etc/resolv.conf`, `/dev/urandom` and
  `/dev/null` — what a static-musl binary plus fontconfig plus TLS for
  the bundle fetch actually need;
- **everything else denied** — `/proc`, `/etc/passwd`, the worker's own
  source under `/app`, and any path holding a secret.

`runCompile` wraps the engine only when a `sandbox` config is supplied.
Unset — a `pnpm dev` on a laptop, and the test suites — spawns the engine
directly, byte-identical to before. `TECTONIC_UNTRUSTED_MODE=1` is also
set: belt to the filesystem boundary, since Landlock still permits
executing the read-only-allowed system binaries a shell-escape would
reach for.

The helper is built from source in a `debian:bookworm-slim` stage of
`Dockerfile.worker` and copied into the runtime image at
`/usr/local/bin/aeolus-sandbox`. The Landlock ABI is negotiated at
runtime, not at build time — `apply()` masks off `REFER` below ABI 2 and
`TRUNCATE` below ABI 3 — so one binary works across kernels.

### Rollout: observe, then enforce

**The image ships `AEOLUS_SANDBOX_MODE=audit`** (`Dockerfile.worker`),
and that is deliberate. Landlock needs a kernel of 5.13 or newer, the
LSM enabled at boot, and a seccomp profile that does not block the three
syscalls; none of those are things this project can know about the host
an operator runs it on. A default of `enforce` would mean that on some
fraction of hosts, every compile fails on first use with no obvious
cause.

So:

1. **`audit`** — the worker runs `aeolus-sandbox --probe` at boot and
   prints `landlock enforcing (ABI vN)` or
   `landlock UNAVAILABLE (<reason>)`, where the reason distinguishes
   "kernel < 5.13", "disabled at boot (not in CONFIG_LSM)" and "blocked
   (seccomp filter)". Every compile is *wrapped but not gated*: it runs
   even if the ruleset could not be applied. This surfaces the kernel's
   answer in the worker's log at zero risk to compiles.
2. **`enforce`** — once that line says the kernel supports it, set
   `AEOLUS_SANDBOX_MODE=enforce`. In enforce mode a ruleset that cannot
   be applied makes the helper **exit non-zero without exec**: the
   engine never runs unconfined.

`.env.example` says this in the operator's words, with the
`docker compose logs worker | grep sandbox` line to read.

Any value other than `audit` or `enforce` — including unset — means no
sandbox at all, and the worker says so at boot
(`sandbox DISABLED (AEOLUS_SANDBOX_MODE unset)`). That is loud on
purpose: silence would be indistinguishable from working.

### Fallback hedges (kernel-independent)

- **Least-privilege secret injection.** Give the worker only what it
  reads: `DATABASE_URL`, `AEOLUS_S3_BUCKET` and the object-store
  credentials. It has never read the cookie secret, and it should never
  be handed one.
- **No outbound network.** With `AEOLUS_TECTONIC_BUNDLE` pointing at a
  bundle the operator hosts ([`0011`](0011-latex-package-cache.md)), the
  worker needs no egress at all, and the container can be run with none.
  Defence in depth: the confirmed exfiltration path is file-read → PDF,
  which no network control stops, but removing egress removes the easier
  one.

## Consequences

- With enforce on, the arbitrary-read primitive is closed: the engine
  cannot open `/proc`, `/etc/passwd`, the worker's own files, or any
  path holding a secret.
- With the shipped `audit` default, it is **not** closed. That is the
  cost of not guessing about the host kernel, and it is why the boot
  line exists and why `.env.example` tells the operator to act on it.
- `--untrusted` is **not** a valid `-X compile` flag (it lives on
  `-X build` and the V1 CLI); untrusted mode is set through
  `TECTONIC_UNTRUSTED_MODE` instead.
- **Residual:** Landlock ABI v1–v3 does not gate network access (TCP
  filtering arrived in ABI v4 / kernel 6.7). This confines the
  filesystem, not egress.
- Documentation that claimed a `--network=none` container, a seccomp
  profile, or dropped capabilities was false and was corrected in the
  same change. The real controls are the unprivileged `compiler` user
  and this sandbox.

## Alternatives considered

- **Source pre-scan** rejecting `\input` of absolute or `..` paths. A
  blocklist, defeatable by macro expansion (`\input\somemacro`, catcode
  tricks). Rejected as a boundary; Landlock is the allowlist.
- **chroot or a mount namespace.** Needs `CAP_SYS_ADMIN` /
  `CAP_SYS_CHROOT`, which container runtimes drop by default and which
  it would be wrong to ask an operator to add back for a document
  compiler.
- **A prebuilt third-party sandbox binary** (bubblewrap, landrun). Adds
  a supply-chain surface; a ~260-line in-repo C helper is preferable for
  something that is a security boundary.
