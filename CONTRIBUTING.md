# Contributing

Bug reports, patches and questions are all welcome. This file is about what
makes a change easy to accept.

## Before you start

For anything larger than a bug fix, open an issue first and describe what you
want to change. It costs you an hour of writing and can save you a weekend of
work on something that will not be merged.

For a security problem, do not open an issue. See `SECURITY.md`.

## Getting the tests running

You need Node 22, [pnpm](https://pnpm.io), and Docker. Docker is not for
running the app here — it is what the integration and end-to-end suites use to
start a real Postgres and a real MinIO, because a fake would not catch the
things those tests exist to catch.

```sh
pnpm install
pnpm typecheck
pnpm test
```

`pnpm test` runs the unit and integration suites. The compile tests additionally
need Tectonic and Typst on your `PATH`; without them those files skip loudly
rather than passing quietly.

The end-to-end suite drives a real browser:

```sh
pnpm --filter @aeolus/tests-e2e exec playwright install --with-deps chromium
pnpm test:e2e
```

Running the app itself while you work on it:

```sh
cp .env.example .env
# put a value in AEOLUS_COOKIE_SECRET
docker compose up -d
```

## What CI checks

Everything below runs on every pull request. Run the ones that are fast before
you push.

| | |
|---|---|
| `pnpm lint` | ESLint over every package |
| `pnpm format:check` | Prettier. `pnpm format` fixes it |
| `pnpm typecheck` | `tsc --noEmit` over every package |
| `pnpm test` | Unit and integration |
| `pnpm test:e2e` | Playwright |
| `pnpm check:refs` | No references to the private codebase this was forked from |
| `pnpm check:contrast` | Every colour pair clears WCAG AA, in both themes |
| `pnpm check:brand` | The committed icons still match what the generator produces |
| Docker workflow | Builds all three images, starts the stack, and drives a first run end to end |

Two of those are unusual enough to explain.

**`check:refs`** exists because Aeolus was forked out of a private codebase. It
refuses to let an internal hostname, an account identifier or a colleague's name
reach a public repository. If it fires, remove the reference. Do not add an
exception to make the build green.

**`check:contrast`** reads the real colour tokens and checks every
foreground/background pair the app actually paints. If you change a colour and
this fails, change the colour, not the threshold.

## Changing the schema

Migrations are generated, never hand-written:

```sh
pnpm --filter @aeolus/db exec drizzle-kit generate
```

Edit `packages/db/src/schema.ts`, run that, and commit the generated SQL and
the snapshot together. CI re-runs the generator and fails if it produces a diff,
which is how a schema change without a migration gets caught.

## Changing colours or the mark

The palette lives in `apps/web/tailwind.preset.cjs` and
`apps/web/src/styles/tokens.css`. The mark and every icon derived from it come
from one description in `scripts/build-brand-assets.mjs`; run `pnpm brand` to
regenerate them and commit the result.

## Pull requests

- One change per pull request. A refactor and a fix in the same branch is two
  reviews wearing one hat.
- Say what the change does and why, not just what files moved.
- Tests for anything that could regress. A bug fix should come with the test
  that would have caught it.
- Update the documentation in the same pull request. `docs/ARCHITECTURE.md`
  describes how the thing works; if your change makes it wrong, fix it there
  too.
- Comments should explain *why*, not restate the code. The code already says
  what it does.

## Licence

Aeolus is AGPL-3.0-only. Contributions are accepted under the same licence —
opening a pull request means you are offering your change under it, and that
you have the right to.

There is no contributor licence agreement and no copyright assignment.
