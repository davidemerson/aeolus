// Aeolus — a collaborative LaTeX and Typst editor you host yourself.
// Copyright (C) 2026 David Emerson
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
// for more details. You should have received a copy of it along with this
// program; if not, see <https://www.gnu.org/licenses/>.

import { SESClient } from '@aws-sdk/client-ses';
import PgBoss from 'pg-boss';

import { blobStoreFromEnv } from '@aeolus/crdt';
import {
  DEV_COOKIE_SECRET,
  DEV_DATABASE_URL,
  db as createDb,
  envFlag,
  envFlagOrUndefined,
  poolSslFor,
  requireEnv,
} from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { MemoryMailAdapter, SesMailAdapter, type MailAdapter } from '../mail.js';
import { buildServer } from '../server.js';
import { bootstrapFirstAdmin } from '../services/credentials.js';

// Bound on graceful shutdown. ECS sends SIGTERM and SIGKILLs after the
// task's stopTimeout (30 s by default; the aeolus manifest sets none), so
// a drain that has not finished by then is killed anyway — better to
// exit(1) ourselves with a log line than to be killed silently.
const SHUTDOWN_DEADLINE_MS = 25_000;

/** A space- or comma-separated environment value as a list. */
function splitList(raw: string | undefined): string[] | undefined {
  const parts = (raw ?? '')
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * AEOLUS_TRUST_PROXY — whose x-forwarded-for the app believes.
 *
 * Unset or off: nobody, and `request.ip` is the socket peer. That is correct
 * and useless behind a reverse proxy, where every caller looks like the proxy.
 *
 * A list of addresses, CIDR blocks, or the names `loopback`, `linklocal` and
 * `uniquelocal`: those peers are trusted to have written the header. This is
 * the right answer for the bundled compose stack, where the proxy sits on a
 * private Docker network — `uniquelocal` covers it.
 *
 * `true`: believe the whole chain from anyone. Only safe where the app cannot
 * be reached except through the proxy, because otherwise the caller simply
 * writes whichever client address they like and the sign-in rate limiter
 * meters a fiction.
 *
 * A bare hop count is deliberately not supported: Fastify's numeric form
 * cannot validate the peer, so it trusts nothing and looks like a silent
 * misconfiguration. Name the proxy instead.
 */
function parseTrustProxy(raw: string | undefined): boolean | string {
  const value = raw?.trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  return value;
}

/** The ws origin, as a CSP connect-src source, when it is not this origin. */
function connectSrcFor(wsUrl: string | undefined): string[] | undefined {
  const value = wsUrl?.trim();
  if (!value) return undefined;
  try {
    return [new URL(value).origin];
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // Required in production (ADR 0024): a missing DATABASE_URL or
  // AEOLUS_COOKIE_SECRET is a boot failure, not a fallback to localhost or to
  // a public constant. The dev defaults apply only when NODE_ENV is not
  // 'production'.
  const connectionString = requireEnv('DATABASE_URL', DEV_DATABASE_URL);
  const cookieSecret = requireEnv('AEOLUS_COOKIE_SECRET', DEV_COOKIE_SECRET);

  // Apply schema migrations before opening connections. Drizzle's
  // migrate() takes a Postgres advisory lock so concurrent boots
  // across api / ws / worker serialize cleanly; the
  // __drizzle_migrations table makes each call idempotent.
  await runMigrations(connectionString);

  const { db, pool } = createDb({ connectionString });

  // First launch. With no users at all there is no way into the instance, so
  // create the administrator and print a generated passphrase once. The row is
  // flagged must_set_passphrase: signing in with the printed value leads
  // straight to setup, and the value stops working as soon as a passphrase is
  // chosen. Every later boot finds users and does nothing.
  const bootstrapAdmin = await bootstrapFirstAdmin(
    db,
    process.env.AEOLUS_BOOTSTRAP_ADMIN_EMAIL?.trim() || 'admin@localhost',
  );
  if (bootstrapAdmin.created && bootstrapAdmin.passphrase) {
    // Written to stdout, not through the logger: this is the one line an
    // operator has to read out of `docker compose logs`, and it must not be
    // buried inside a JSON envelope or dropped by a log level.
    process.stdout.write(
      [
        '',
        '  ┌───────────────────────────────────────────────────────────────┐',
        '  │  First launch: administrator account created.                 │',
        '  │  This passphrase is shown once and cannot be recovered.       │',
        '  └───────────────────────────────────────────────────────────────┘',
        `      email:      ${bootstrapAdmin.email}`,
        `      passphrase: ${bootstrapAdmin.passphrase}`,
        '',
        '  Sign in with it, then choose your own passphrase when prompted.',
        '',
        '',
      ].join('\n'),
    );
  }

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const publicBaseUrl = process.env.AEOLUS_PUBLIC_BASE_URL ?? 'http://localhost:5173';

  // AEOLUS_S3_BUCKET unset → in-memory blobs (dev only; blobStoreFromEnv
  // refuses that in production).
  const blobs = blobStoreFromEnv();

  const boss = new PgBoss({ connectionString, ssl: poolSslFor(connectionString) });
  await boss.start();

  // AEOLUS_MAIL_FROM, when set, switches the mail adapter from the
  // in-memory captor (dev / test) to SES. The from-address domain
  // must already be verified in the deployed account; the api task
  // role needs ses:SendEmail. Absent value keeps outbound mail
  // local — useful for development and for boot in environments
  // where SES isn't wired yet.
  const fromAddress = process.env.AEOLUS_MAIL_FROM;
  const mail: MailAdapter = fromAddress
    ? new SesMailAdapter({
        client: new SESClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
        fromAddress,
      })
    : new MemoryMailAdapter();

  const app = await buildServer({
    db,
    blobs,
    cookieSecret,
    cookieSecure: envFlag('AEOLUS_COOKIE_SECURE'),
    // AEOLUS_COOKIE_DOMAIN — set the cookie's Domain attribute so it's
    // sent to every Aeolus subdomain (api + ws). Leaving it unset
    // makes the cookie host-only on the api hostname, which means
    // the WebSocket upgrade to aeolus-ws.* never carries auth and
    // every editor compile silently fails because no edits are
    // persisted (rooms=0 on the ws side).
    cookieDomain: process.env.AEOLUS_COOKIE_DOMAIN || undefined,
    mail,
    publicBaseUrl,
    enableDevRoutes: envFlag('AEOLUS_ENABLE_DEV_ROUTES'),
    // Unset → undefined, so buildServer's "on in production" default
    // applies. `=== '1'` here produced a boolean whatever the value and
    // kept production error logging off until 2026-09-13.
    logger: envFlagOrUndefined('AEOLUS_LOG'),
    compileBoss: boss,
    // AEOLUS_FRAME_ANCESTORS — who may put Aeolus in an iframe, as CSP source
    // expressions separated by spaces or commas. Default: nobody but Aeolus.
    frameAncestors: splitList(process.env.AEOLUS_FRAME_ANCESTORS),
    // The SPA connects to the api (same origin) and to ws. When ws is on
    // another origin, the enforced CSP has to know about it.
    connectSrc: connectSrcFor(process.env.AEOLUS_WS_URL),
    // AEOLUS_TRUST_PROXY — see buildServer. Off unless set.
    trustProxy: parseTrustProxy(process.env.AEOLUS_TRUST_PROXY),
  });

  await app.listen({ host, port });
  app.log.info({ host, port }, 'api listening');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      app.log.error({ signal, deadlineMs: SHUTDOWN_DEADLINE_MS }, 'shutdown deadline hit; exiting');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    try {
      await app.close();
      await boss.stop({ graceful: true, wait: true });
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  // `once`: a second signal during the drain must not start a second
  // shutdown (and a second pool.end()).
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`[api] fatal: ${String(err)}\n`);
  process.exit(1);
});
