# Runbook: Electron builds

## When to use this

Building or smoke-testing the desktop shell locally, or reading what the
Build Electron workflow does before changing it.

## Prerequisites

- Node 22 LTS, pnpm 10+
- Linux: `Xvfb` for headless smoke tests
- macOS: Xcode CLI tools (only once signing is taken up — ADR 0006)
- Windows: NSIS installed (bundled by electron-builder)

## Build commands

```bash
# Linux (AppImage + deb)
pnpm build:electron:linux

# macOS (dmg + zip, arm64 + x64)
pnpm build:electron:mac

# Windows (nsis + portable, x64)
pnpm build:electron:win
```

All commands compile TypeScript first, then invoke `electron-builder`.
Output lands in `apps/electron/release/`.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `AEOLUS_APP_URL` | Webapp URL loaded by the Electron shell | `http://localhost:8080` when packaged (the compose stack's port), `http://localhost:5173` in a development run — `DEFAULT_APP_URL` in `apps/electron/src/main.ts`. Set it to your own instance before shipping an installer. |
| `AEOLUS_UPDATES_HOST` | Enables the (dormant) updater against `https://<host>/` in a packaged build | unset — no build sets it |
| `CI` | Set to `true` in CI to avoid pnpm TTY prompts | — |

## Running the smoke test

```bash
# Start a virtual framebuffer (CI / headless Linux)
Xvfb :99 -screen 0 1024x768x24 &

# Run the test
DISPLAY=:99 pnpm --filter @aeolus/tests-electron run test
```

The smoke test spawns the `linux-unpacked` binary with
`--headless-test --no-sandbox`, pointing `AEOLUS_APP_URL` at a `data:`
URL. The app auto-exits after 2 seconds if the page loads
successfully.

## Troubleshooting

**FUSE errors with AppImage**: The AppImage format requires FUSE.
On CI runners without FUSE, use the unpacked binary at
`apps/electron/release/linux-unpacked/aeolus` instead.

**`app-builder-bin` ENOENT**: Run `rm -rf node_modules && pnpm install`
to ensure the hoisted `app-builder-bin` binary is correctly linked.

**GPU errors in headless mode**: The `--no-sandbox` flag and
`DISPLAY=:99` with Xvfb are required. GPU-related stderr warnings
(e.g. `Exiting GPU process due to errors during initialization`)
are expected and harmless in headless mode.

## Icon

`apps/electron/build/icon.png` (1024 px) is the single source
electron-builder derives `.icns` / `.ico` / Linux icons from. It is
**generated, not hand-drawn**: `scripts/build-brand-assets.mjs` draws the
Aeolus mark from the `MARK` object in that file and writes this PNG
alongside the web favicons, using `@napi-rs/canvas`.

Do not edit it. Change the mark in the script and re-run
`pnpm brand`; `pnpm check:brand` (`--check`) runs in CI and fails if the
committed file differs from what the script produces.

## Verification

- Build Electron is green on all three OSes for the commit.
- Download the Linux artifact, run `--headless-test` (above) — exits 0.
- Launch it: the app loads; a document link to another site opens in
  the system browser and the shell stays on Aeolus; Help → Aeolus guide
  shows `/guide`; About / `window.aeolus.version` shows the package
  version, not `0.0.0`.

## Signing (deferred — ADR 0006)

Current builds are unsigned. Taking signing up means:
- macOS: Apple Developer ID certificate + notarization
- Windows: EV code-signing certificate
- Linux: checksum verification (AppImage stays unsigned)

No update feed is configured: `apps/electron/electron-builder.yml`
sets `publish: null`, and `main.ts` skips `autoUpdater` unless
`AEOLUS_UPDATES_HOST` is set in a packaged build. The updater is
dormant for the unsigned pilot (ADR 0006).
