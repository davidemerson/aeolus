<div align="center">

<img src="apps/web/public/favicon.svg" width="72" alt="">

# Aeolus

**A collaborative LaTeX and Typst editor you host yourself.**

Write source on the left, watch the PDF appear on the right, and let other
people type in the same document at the same time. One `docker compose up`,
one port, no accounts anywhere but your own machine.

</div>

---

Aeolus is deliberately smaller than Overleaf. There are no plan tiers, no
public sharing, and no accounts on somebody else's server. An administrator
creates the accounts, documents are shared with named people, and everything —
the documents, the compiled PDFs, the passphrases — stays on the machine you
put it on.

What it does:

- **Live collaborative editing** on LaTeX and Typst source, with every
  collaborator's cursor visible and no save button to fight over.
- **Compile to PDF** with [Tectonic](https://tectonic-typesetting.github.io/)
  or [Typst](https://typst.app/), previewed beside the source, with the errors
  parsed into something readable.
- **Multi-file projects**: figures, bibliographies, `\input` chains, uploaded
  assets, all in one document.
- **Version history**: checkpoints per file and across a whole project, with a
  diff and a restore.
- **Inline comments** anchored to a selection.
- **Templates** an administrator maintains, so a new document starts right.
- **An audit log** of who did what.
- **A REST API** under `/api/v1`, so a script can do anything you can.
- **A desktop build** for macOS, Windows and Linux, if you would rather not
  live in a browser tab.
- **An AI writing assistant**, if you supply an Anthropic API key. Without one
  the feature is simply absent.

---

## Install

You need [Docker](https://docs.docker.com/get-docker/) with Compose. Nothing
else — no Node, no database, no TeX installation.

```sh
git clone https://github.com/davidemerson/aeolus.git
cd aeolus
cp .env.example .env
```

Open `.env` and put a value in `AEOLUS_COOKIE_SECRET`. It is the one setting
with no default, because a shipped default would be a shared secret that signs
every session on every install:

```sh
openssl rand -base64 48
```

Then:

```sh
docker compose up -d
```

The first build takes a while — the compile worker's image contains Tectonic,
Typst and a small C helper it compiles from source. Later builds are cached.

When it settles, Aeolus is at **http://localhost:8080**.

### First sign-in

With no accounts at all, the api creates an administrator on its first boot and
prints a generated passphrase to its log. Exactly once, and it is not
recoverable:

```sh
docker compose logs api | grep -A 4 "First launch"
```

```
  ┌───────────────────────────────────────────────────────────────┐
  │  First launch: administrator account created.                 │
  │  This passphrase is shown once and cannot be recovered.       │
  └───────────────────────────────────────────────────────────────┘
      email:      admin@localhost
      passphrase: rugby stump cactus dwarf oat marbles
```

Sign in with it. The app will immediately ask you to replace it with a
passphrase only you know, and nothing else in it works until you do.

### Adding other people

There is no self-service signup. Go to **Admin → Users**, add an email address,
and Aeolus generates a passphrase and shows it to you once. Pass it to the
person out of band. They choose their own at their first sign-in, exactly as you
did.

If someone forgets theirs, issue a new one from the same screen. There is no
emailed reset link — a self-hosted install may have no mail server at all, and
a recovery path that depends on one is not a recovery path.

---

## Putting it on a network

The defaults are right for a laptop and wrong for anything else. Three changes
make it a real deployment.

**1. A hostname and TLS.** Point a DNS record at the machine, then in `.env`:

```sh
AEOLUS_SITE_ADDRESS=aeolus.example.com
AEOLUS_PUBLIC_BASE_URL=https://aeolus.example.com
AEOLUS_COOKIE_SECURE=1
```

and in `docker-compose.yml`, publish ports 80 and 443 on the `caddy` service
instead of 8080. Caddy gets a certificate from Let's Encrypt on its own, renews
it, and redirects http to https. `AEOLUS_COOKIE_SECURE=1` stops the session
cookie ever travelling in the clear; leave it off until you have https or
nobody will be able to sign in.

**2. Turn the compile sandbox on.** A LaTeX document is a program, and
`\input{/etc/passwd}` is a valid one. Aeolus confines the engines with
[Landlock](https://landlock.io/), but the default is `audit`, which logs what it
would have blocked and blocks nothing — because `enforce` fails closed, and on a
kernel or container runtime without Landlock it would turn every compile into a
failure.

Check whether this host can:

```sh
docker compose logs worker | grep sandbox
```

`landlock enforcing (ABI vN)` means yes. Then set `AEOLUS_SANDBOX_MODE=enforce`
in `.env` and `docker compose up -d worker`.

**3. Change the database password**, before the first `up` — `POSTGRES_PASSWORD`
is only read when the data volume is created. It never leaves the compose
network, which publishes no database port, but a shared machine is a shared
machine.

---

## Configuration

Everything is in `.env`, which is commented at length; this is the summary.
Every setting is read by the application itself, so it applies whether you use
the bundled compose file or run the containers some other way.

### Required

| | |
|---|---|
| `AEOLUS_COOKIE_SECRET` | Signs the session cookie. Anyone who knows it can mint a session for any account. Changing it signs everybody out, which is how you revoke every session at once. |
| `AEOLUS_PUBLIC_BASE_URL` | The URL people type. Also the Origin the websocket process accepts editing connections from, so a wrong value here does not break sign-in — it breaks editing, quietly. |

### Where it listens

| | Default | |
|---|---|---|
| `AEOLUS_PORT` | `8080` | The port published on your machine. |
| `AEOLUS_SITE_ADDRESS` | `:8080` | What Caddy serves. A hostname here turns on automatic HTTPS. |
| `AEOLUS_COOKIE_SECURE` | off | `Secure` on the session cookie. Turn on with https. |
| `AEOLUS_TRUST_PROXY` | off | Whose `x-forwarded-for` to believe. See below. |
| `AEOLUS_FRAME_ANCESTORS` | `'self'` | Who may put Aeolus in an iframe. |

### Accounts

| | Default | |
|---|---|---|
| `AEOLUS_BOOTSTRAP_ADMIN_EMAIL` | `admin@localhost` | The account created at first launch. Does nothing afterwards. |

### Data

| | Default | |
|---|---|---|
| `POSTGRES_PASSWORD` | `aeolus` | The bundled database. Read once, when its volume is created. |
| `AEOLUS_DB_SSL` | guessed | `disable`, `require` or `verify`. Set it if you use your own database. |
| `AEOLUS_DB_CA_FILE` | — | The CA bundle `verify` checks against. |
| `AEOLUS_S3_BUCKET` | `aeolus` | Snapshots and uploaded assets. |
| `AWS_S3_ENDPOINT` | MinIO | Empty for real S3. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | MinIO's | The SDK needs a key pair even against MinIO; without one it goes looking for instance metadata and hangs. |

### Compiling

| | Default | |
|---|---|---|
| `AEOLUS_SANDBOX_MODE` | `audit` | `enforce` to actually confine the engines. |
| `AEOLUS_TECTONIC_BUNDLE` | Tectonic's relay | A pinned or self-hosted TeX bundle. |

### Optional

| | |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on the writing assistant. |
| `AEOLUS_AI_DAILY_CAP_CENTS` | A spend ceiling for it, across the whole instance. |
| `AEOLUS_MAIL_FROM` | A verified SES sender, for notification mail. Unset, nothing is sent. |
| `AEOLUS_WS_URL` | Only if the websocket process is on a different origin. |
| `AEOLUS_COOKIE_DOMAIN` | Only if api and ws are on different hostnames. |
| `AEOLUS_LOG_LEVEL` | The websocket process's log level. |

### About `AEOLUS_TRUST_PROXY`

Behind a reverse proxy every request arrives from the proxy, so `request.ip` is
the proxy for everybody — and the sign-in rate limit becomes one bucket shared
by every user. Naming the proxy fixes it. The bundled stack sets `uniquelocal`,
which trusts the private Docker network Caddy sits on. Behind a proxy of your
own, give its address or network.

`true` believes the whole `x-forwarded-for` chain from anyone, which is only
safe if the app cannot be reached except through the proxy. Otherwise a caller
writes whichever client address they like and the rate limit meters a fiction.
The ten-failure account lockout is the layer that does not depend on getting
this right.

---

## Upgrading

```sh
git pull
docker compose build
docker compose up -d
```

Schema migrations run automatically at boot, serialised across the three
processes by a Postgres advisory lock, so it does not matter which starts
first. Read `CHANGELOG.md` before a major version.

## Backing up

Two things hold state. Both must be taken together — a database restored
against a mismatched object store gives you documents whose history has holes.

```sh
# The database: users, documents, the collaborative history, the audit log.
docker compose exec -T postgres pg_dump -U aeolus aeolus | gzip > aeolus-db.sql.gz

# Object storage: document snapshots, uploaded assets, compiled PDFs.
mkdir -p aeolus-blobs
docker compose run --rm --entrypoint sh \
  -v "$PWD/aeolus-blobs:/backup" minio-init -c \
  'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
   mc mirror --overwrite local/aeolus /backup'
```

Both of those run in CI on every change, against a live stack, so the commands
above are the ones that were tested rather than the ones somebody remembered.

Restoring is the same in reverse, into a stopped stack. Test it before you need
it.

## Troubleshooting

**The editor says "Connected" but nothing saves.** The session cookie is not
reaching the websocket upgrade. Almost always this is `AEOLUS_PUBLIC_BASE_URL`
not matching the URL in the address bar, or the api and ws being served from
two different hostnames without `AEOLUS_COOKIE_DOMAIN`.

**Documents come back with text missing.** The processes are not sharing an
object store. Check `AEOLUS_S3_BUCKET` is set for all three services and that
`minio-init` completed. Without a shared store each process keeps its own
snapshots in its own memory, and the one that reads a document is not the one
that wrote it.

**Every compile fails.** Look at the worker: `docker compose logs worker`. If
the sandbox line says `landlock UNAVAILABLE` and the mode is `enforce`, that is
the cause; it is failing closed as designed. Set `AEOLUS_SANDBOX_MODE=audit`
and read the section above.

**The first LaTeX compile takes minutes.** Tectonic is downloading its TeX
bundle. It is cached in a volume after that. Set `AEOLUS_TECTONIC_BUNDLE` to
host it yourself, or use Typst, which needs nothing.

**Nobody can sign in and there is no account.** If the users table is genuinely
empty, the api bootstraps an administrator on its next boot. If it is not, ask
an existing administrator to issue a passphrase. If there is no reachable
administrator at all, the only way in is the database.

**Sign-in says the account is locked.** Ten failures locks it for fifteen
minutes. Wait, or have an administrator issue a new passphrase, which clears it.

---

## How it fits together

Six containers. Each is there because the application does not work without it.

```
                    ┌──────────────────────────────────┐
   browser ────────▶│  caddy        one origin, TLS    │
                    │    /ws  ───▶ ws                  │
                    │    /    ───▶ api                 │
                    └───────┬──────────────────┬───────┘
                            │                  │
              ┌─────────────▼──────┐   ┌───────▼─────────────┐
              │  api               │   │  ws                 │
              │  REST + the SPA    │   │  live editing (Yjs) │
              └─────┬────────┬─────┘   └───┬───────────┬─────┘
                    │        │             │           │
                    │        └─────────────┼───────┐   │
                    │                      │       │   │
              ┌─────▼──────────────────────▼───┐ ┌─▼───▼──────────┐
              │  postgres                      │ │  minio         │
              │  users, docs, history, queue   │ │  snapshots,    │
              └─────▲──────────────────────────┘ │  assets, PDFs  │
                    │                            └─▲──────────────┘
              ┌─────┴────────────────────────────┬─┘
              │  worker                          │
              │  Tectonic + Typst, in Landlock   │
              └──────────────────────────────────┘
```

**Everything is on one origin.** That is not tidiness. The session cookie has to
reach the WebSocket upgrade, and a browser will not send a cookie to a different
host — so split them and the editor connects, looks fine, and silently saves
nothing.

**MinIO is not optional.** With no shared blob store each process keeps its own
snapshots in its own memory. The api writes a snapshot and prunes the updates it
subsumes; the ws process then reads a document that has lost everything before
that point. Documents come back truncated, and nothing logs a thing.

**Compiles are queued, not synchronous.** The api puts a job on a Postgres-backed
queue and returns; the worker picks it up, runs the engine with its filesystem
confined to the job's own directory, and writes the PDF to object storage.

For the detail — the CRDT persistence model, the ACL, the multi-file layout, the
compile pipeline, the API — read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Sign-in

Aeolus checks an email and a passphrase itself. There is no identity provider to
stand up and nothing leaves the server.

A passphrase, not a password: at least sixteen characters, and either four or
more words or a single string of twenty-four. No rules about capitals, digits or
punctuation, and no expiry — those rules produce worse secrets, not better ones.
This follows [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html),
which has said so since 2017. The setup screen offers a generated suggestion for
anyone who would rather not choose.

Stored with scrypt from Node's standard library, with the parameters recorded
beside each hash so they can be raised later without invalidating anyone's
credential. Ten wrong attempts lock an account for fifteen minutes. A wrong
passphrase and an address with no account are indistinguishable, in the response
and in the time it takes.

---

## Development

Node 22 and [pnpm](https://pnpm.io) 10. Docker for the tests, which use a real
Postgres and a real MinIO rather than a fake.

```sh
pnpm install
pnpm typecheck
pnpm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rest: what CI checks, how to
change the schema, and how to regenerate the brand assets.

### Repository layout

```
apps/
  api/              Fastify: REST API, /api/v1, and it serves the SPA
  ws/               y-websocket: one live editing session per open file
  compile-worker/   pg-boss consumer running Tectonic and Typst
  web/              React + Vite single-page app
  electron/         desktop shell
packages/
  auth/             sessions, the ACL, the passphrase policy
  crdt/             Yjs persistence and the blob store
  db/               drizzle schema and migrations
  shared/           UI components used by more than one surface
tests/
  integration/      real Postgres, real MinIO
  e2e/              Playwright against the whole stack
  electron/         the shell's navigation policy
scripts/            the CI gates and the brand-asset generator
docs/               architecture, API, test plan, decisions, runbooks
```

---

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works, in detail |
| [`docs/API.md`](docs/API.md) | The `/api/v1` machine API |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and what to harden |
| [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) | Every behaviour, and the test that holds it |
| [`docs/DECISIONS/`](docs/DECISIONS/) | Why things are the way they are |
| [`docs/RUNBOOKS/`](docs/RUNBOOKS/) | Operational procedures |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed |

There is also a guide inside the app, at `/guide`, written for the people using
it rather than the people running it.

---

## Licence

Copyright (C) 2026 David Emerson.

Aeolus is free software under the **GNU Affero General Public License, version
3 or later**. You may use, study, change and redistribute it. The Affero clause
means one thing beyond the ordinary GPL: if you run a modified version and let
other people use it over a network, you have to offer them its source. Running
an unmodified copy for your own team asks nothing of you.

Full text in [`LICENSE`](LICENSE).

Bundled fonts and wordlists carry their own licences — see
[`third_party/NOTICE.md`](third_party/NOTICE.md).
