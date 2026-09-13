# Changelog

Notable changes, newest first. Dates are the day the change landed on `main`.

## Unreleased

### 1.0.0 — first public release, 2026-09-13

Aeolus is published as a self-hostable application under the GNU Affero General
Public License version 3. It began as an internal tool at a company and was
forked for public use; this entry is the difference between the two, because it
is the only version history a reader of this repository has.

**Install it with Docker and nothing else.**

- `docker-compose.yml` brings up the whole application: a Caddy reverse proxy,
  the api, the websocket process, the compile worker, Postgres, and MinIO for
  object storage. One published port.
- Everything is behind a single origin. The session cookie reaches the
  WebSocket upgrade because the upgrade is on the same host; split across two
  hostnames the editor connects, looks fine, and saves nothing.
- MinIO is part of the stack, not an option. Without a shared blob store each
  process keeps its own snapshots in its own memory and documents read back
  truncated, silently.
- `.env.example` documents every setting, including the ones that were
  previously baked into an image.
- Point Caddy at a real hostname and it gets and renews a TLS certificate on
  its own.

**Sign-in is an email and a passphrase, checked by your instance.**

- The identity-provider integration is gone. There is nothing to register, no
  tenant, no directory, and nothing leaves the server.
- At first launch, with no accounts at all, the api creates an administrator
  and prints a generated passphrase to its log, once. Signing in with it leads
  straight to a screen that makes you replace it.
- The policy follows NIST SP 800-63B: at least sixteen characters, and either
  four or more words or a single string of twenty-four. No character-class
  rules, no expiry, a denylist of the obvious choices, and a generated
  suggestion for anyone who would rather not pick.
- Stored with scrypt from Node's standard library, parameters recorded beside
  each hash so they can be raised later without invalidating anyone's
  credential.
- Ten failed attempts lock an account for fifteen minutes. A wrong passphrase
  and an address with no account are indistinguishable, in both the response
  and the time it takes.
- Administrators create accounts and issue replacement passphrases from
  **Admin → Users**, each shown exactly once. There is no emailed reset: a
  self-hosted install may have no mail server.

**One image runs anywhere.**

- The WebSocket URL used to be frozen into the JavaScript bundle at build time,
  so an image only worked for the hostname it was built for. The api now stamps
  the runtime configuration into the page it serves.
- Database TLS is decided by `AEOLUS_DB_SSL` (`disable`, `require`, `verify`)
  instead of guessed from the hostname, which previously meant any Postgres not
  named `postgres` was met with verified TLS and a boot failure.
- `trustProxy` is off unless `AEOLUS_TRUST_PROXY` says otherwise, and it takes
  an address or network rather than a blanket yes. Believing an unverified
  `x-forwarded-for` makes the sign-in rate limit meter a fiction.
- The CSP `frame-ancestors` list defaults to `'self'` and is set by
  `AEOLUS_FRAME_ANCESTORS`.
- The Landlock sandbox around Tectonic and Typst defaults to `audit` rather
  than `enforce`, because enforce fails closed on a host without Landlock and
  would turn every compile into a failure. The worker prints which applies at
  boot. Turn it to `enforce`.

**New look.**

- Jost and JetBrains Mono, both under the SIL Open Font License, replacing
  licensed faces that could not be redistributed.
- A teal palette, and a mark of three strokes of moving air. Every icon,
  favicon and the link-preview card come from one description in
  `scripts/build-brand-assets.mjs`, so they cannot drift apart.
- `scripts/check-contrast.mjs` holds 91 colour pairs to WCAG AA in both light
  and dark, and fails the build if a palette change breaks one.

**What was removed.** Everything specific to the environment it was built in:
the deployment pipeline, the internal hostnames, the overlay network, the
monitoring, the licensed fonts and the company's artwork. `pnpm check:refs`
runs on every commit and refuses to let any of it back in.
