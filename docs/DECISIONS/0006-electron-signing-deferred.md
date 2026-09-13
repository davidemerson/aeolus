# 0006 — Electron builds ship unsigned

- **Status**: accepted
- **Date**: 2026-04-15

## Context

The desktop app is a thin wrapper around the hosted webapp. Signing it
costs money and identity, and neither belongs in a project anyone can
fork and build:

- **macOS** signing needs an Apple Developer Program membership and a
  Developer ID certificate.
- **Windows** EV code-signing certificates are expensive, and
  SmartScreen's reputation is earned per-publisher — a certificate the
  project bought would not travel to a fork anyway.
- **Linux** AppImages have never been signed here.

Anyone who builds their own installers signs them with their own
identity. The repository cannot do it for them.

## Decision

Ship unsigned builds for all three platforms.
`apps/electron/electron-builder.yml` and
`.github/workflows/build-electron.yml` contain every signing and
notarization hook, gated on environment variables that are unset.
Enabling signing requires no code change — only setting the secrets.

## Consequences

- **macOS**: Gatekeeper shows "unidentified developer" on first launch.
  Right-click → Open once to bypass.
- **Windows**: SmartScreen shows "Unknown publisher." More info → Run
  anyway, once.
- **Linux**: AppImage is unsigned; no user-visible warning.

## To enable Mac signing (no code change)

1. Export the Developer ID Application certificate as a `.p12`,
   base64-encode it, and store it as the repository secret `CSC_LINK`.
2. Store the `.p12` password as `CSC_KEY_PASSWORD`.
3. Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
4. Re-run the release workflow on a tagged commit.

The workflow's "Configure Mac signing" step is conditional on
`APPLE_ID` being set, and electron-builder picks the rest up from the
environment.

## To enable Windows signing

Same pattern: the `.pfx` as `CSC_LINK` (base64) and its password as
`CSC_KEY_PASSWORD`.

## Auto-update is wired but dormant

`electron-builder.yml` sets `publish: null`, so the build produces
installers as workflow artifacts and publishes no update feed.
`apps/electron/src/main.ts` imports `electron-updater` and calls
`autoUpdater.setFeedURL({ provider: 'generic', url: … })` only when
`AEOLUS_UPDATES_HOST` is set at build time; unset, the updater never
starts.

Turning it on means hosting a generic update feed somewhere and setting
that host — which is a feature decision for whoever distributes the
builds, not a CI step. The publish step that used to sit at the end of
the workflow was removed because it uploaded to a bucket for which no
credential was ever configured, so it could not have worked.
