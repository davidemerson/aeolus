import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type PgBoss from 'pg-boss';

import type { BlobStore } from '@aeolus/crdt';
import type { Database } from '@aeolus/db';

import {
  readTheme,
  runtimeConfigFromEnv,
  stampConfig,
  stampTheme,
  type RuntimeConfig,
} from './appearance.js';
import type { MailAdapter } from './mail.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminAuditRoutes } from './routes/admin-audit.js';
import { registerAdminDiagnosticsRoutes } from './routes/admin-diagnostics.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerFileRoutes } from './routes/files.js';
import { registerCheckpointRoutes } from './routes/checkpoints.js';
import { registerProjectCheckpointRoutes } from './routes/project-checkpoints.js';
import { registerProjectZipRoutes } from './routes/project-zip.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerDocRoutes } from './routes/docs.js';
import { registerHealthRoutes } from './routes/health.js';
import {
  BROWSER_RATE_LIMITS,
  rateLimitedResponse,
  type BrowserRateLimits,
} from './middleware/rate-limits.js';
import { publicError } from './middleware/reply-errors.js';
import { MAX_SINGLE_BYTES } from './services/file-paths.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerV1 } from './v1/plugin.js';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerWsTicketRoutes } from './routes/ws-tickets.js';
import { createSessionStore, type SessionStore } from './session.js';

export interface BuildServerDeps {
  db: Database;
  blobs: BlobStore;
  cookieSecret: string;
  mail: MailAdapter;
  publicBaseUrl?: string;
  logger?: boolean;
  cookieSecure?: boolean;
  // Cookie Domain — sent on the Set-Cookie. Default unset = host-only, which
  // is what the bundled compose stack wants: one origin fronts both api and
  // ws, so the cookie reaches both. Split them across subdomains and the
  // WebSocket upgrade carries no cookie at all — every edit is silently
  // dropped. Set this to the shared parent domain in that case.
  cookieDomain?: string;
  enableDevRoutes?: boolean;
  // Optional pg-boss instance used to enqueue compile jobs. When
  // omitted, the api still serves compile-status reads but
  // POST /docs/:id/compile returns 503.
  compileBoss?: PgBoss;
  presignCompiledPdf?: (key: string) => Promise<string>;
  // Per-route budgets for the browser plane (ADR 0025). Default
  // BROWSER_RATE_LIMITS; a test that mints dozens of tokens per minute
  // from one address raises tokenMint.
  browserRateLimits?: BrowserRateLimits;
  // Optional path to the built apps/web SPA dist directory. When
  // present, the server serves it at `/` with an SPA fallback for
  // client-side routes (`/login`, `/invite/:token`, `/docs/:id`,
  // etc.) and accepts API requests at both `/<route>` and
  // `/api/<route>` (the SPA's fetches use the `/api/` prefix that
  // Vite's dev proxy strips). Default: serve from
  // /app/apps/web/dist if it exists, else don't serve any SPA.
  webDistPath?: string | null;
  // CSP frame-ancestors, as source expressions. Default ["'self'"] — nothing
  // may frame the app but the app. Widen it only to embed Aeolus in another
  // site you control; every origin listed here can put the editor in an
  // iframe on a page you do not.
  frameAncestors?: string[];
  // Extra CSP connect-src sources. The SPA talks to the api and the ws
  // process; when ws is not on this origin its URL belongs here.
  connectSrc?: string[];
  // Fastify's trustProxy: false (default), true, or a comma-separated list of
  // proxy addresses / CIDRs / the names loopback, linklocal, uniquelocal. Off
  // by default because `true` makes request.ip whatever the caller writes in
  // x-forwarded-for, and the sign-in rate limiter keys on it.
  trustProxy?: boolean | string | string[];
  // Runtime configuration injected into the SPA shell. Default: read from the
  // environment (AEOLUS_WS_URL).
  runtimeConfig?: RuntimeConfig;
}

// API routes live under /api/* so the SPA can hold the URL space
// at root for client-side routing (/docs/:id, /login, /invite/:token,
// etc.). /healthz stays at root because the manifest pins the ALB's
// health check there.
const BODY_LIMIT_BYTES = 5 * 1024 * 1024;

function frameAncestorsCsp(sources: readonly string[]): string {
  return `frame-ancestors ${sources.join(' ')}`;
}

// The candidate enforced policy. `style-src 'unsafe-inline'` is what
// CodeMirror and Tailwind's runtime need; `worker-src blob:` is pdf.js;
// `connect-src` covers the api itself, whatever ws host was configured, and
// the Vite dev server's websocket on a laptop.
function reportOnlyCsp(frameAncestors: readonly string[], connectSrc: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...connectSrc, 'ws://localhost:*', 'http://localhost:*'].join(' '),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestorsCsp(frameAncestors),
    'report-uri /api/csp-report',
  ].join('; ');
}

function isApiPath(url: string): boolean {
  const pathname = url.split('?', 1)[0];
  return pathname === '/healthz' || pathname === '/api' || pathname.startsWith('/api/');
}

export interface ServerContext {
  db: Database;
  blobs: BlobStore;
  sessions: SessionStore;
  cookieSecure: boolean;
  cookieDomain?: string;
  mail: MailAdapter;
  publicBaseUrl: string;
  compileBoss: PgBoss | null;
  presignCompiledPdf?: (key: string) => Promise<string>;
  rateLimits: BrowserRateLimits;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: ServerContext;
  }
}

export async function buildServer(deps: BuildServerDeps): Promise<FastifyInstance> {
  const frameAncestors = deps.frameAncestors?.length ? deps.frameAncestors : ["'self'"];
  const frameAncestorsHeader = frameAncestorsCsp(frameAncestors);
  const reportOnlyHeader = reportOnlyCsp(frameAncestors, deps.connectSrc ?? []);

  const app = Fastify({
    // On in production unless AEOLUS_LOG says otherwise. `disableRequestLogging`
    // below already suppresses the per-request access line, so what this
    // actually turns on is the error log — without it, the setErrorHandler's
    // `request.log.error({ err }, 'request failed')` writes to nothing and a
    // 5xx leaves no trace at all.
    logger: deps.logger ?? process.env.NODE_ENV === 'production',
    disableRequestLogging: true,
    // Request id = whatever the proxy in front already stamped, so an error
    // line here can be joined to its access log; a UUID otherwise. Fastify's
    // default is a per-process counter, which restarts at req-1 on every
    // deploy.
    genReqId: (request) => {
      const forwarded = request.headers['x-request-id'];
      return typeof forwarded === 'string' && forwarded.length > 0 ? forwarded : randomUUID();
    },
    // Off unless the deployment says otherwise. Behind a reverse proxy the
    // socket peer is the proxy, so `request.ip` is the proxy for every caller
    // — but `trustProxy: true` believes the whole of x-forwarded-for, which
    // the caller writes, and the sign-in rate limiter keys on the result.
    // Naming the proxy's address or network is the safe way to get the real
    // client back; see AEOLUS_TRUST_PROXY in bin/server.ts.
    trustProxy: deps.trustProxy ?? false,
    // Cap on non-multipart bodies. Fastify's default is 1 MiB, which the v1
    // "replace a text file's content" route could exceed on a large .tex —
    // and the failure surfaced as Fastify's own FST_ERR code. 5 MiB is far
    // above any real document and far below the 25 MiB upload cap.
    bodyLimit: BODY_LIMIT_BYTES,
  });

  // Security headers (ADR 0025). Two things are deliberately NOT helmet's
  // defaults:
  //  - X-Frame-Options is off: it has no cross-origin allow-list, so a stray
  //    SAMEORIGIN would override whatever AEOLUS_FRAME_ANCESTORS permits.
  //  - Cross-Origin-Opener-Policy is same-origin-allow-popups, not
  //    same-origin: the PDF preview opens in a new tab and reaches back
  //    through window.opener; a strict COOP severs that.
  // The CSP itself is not helmet's either — see the two headers below.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    xFrameOptions: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // The SPA loads its own assets and the Electron shell loads the app from
    // this origin, so same-origin is fine for everything this server sends.
    // It does NOT govern framing.
    crossOriginResourcePolicy: { policy: 'same-origin' },
    strictTransportSecurity: deps.cookieSecure
      ? { maxAge: 31_536_000, includeSubDomains: false }
      : false,
  });

  // Framing policy on every response — API routes, SPA assets, the index.html
  // fallback, 404s. Set-if-absent so a route could ship a stricter CSP later.
  // Never send X-Frame-Options: it has no cross-origin allow-list and a stray
  // DENY wins over the CSP in some engines. Registered before all plugins and
  // routes so everything inherits it.
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', frameAncestorsHeader);
    }
    // The full policy, in report-only mode first (ADR 0025 — observe, then
    // enforce). The E2E suite drives the SPA from the Vite dev server, so an
    // enforced policy here would go live untested; violations from real use
    // land at POST /api/csp-report and in the api log. Enforce once the log
    // has been quiet.
    if (!reply.hasHeader('content-security-policy-report-only')) {
      reply.header('content-security-policy-report-only', reportOnlyHeader);
    }
  });

  await app.register(cookie, {
    secret: deps.cookieSecret,
  });

  await app.register(multipart, {
    // One file per request (every upload route reads exactly one), a
    // handful of text fields, and the same per-file cap the routes enforce
    // while draining. Before this only fileSize was set, so a request could
    // carry an unbounded number of parts.
    limits: { fileSize: MAX_SINGLE_BYTES, files: 1, fields: 8, fieldSize: 4 * 1024, parts: 12 },
  });

  const publicBaseUrl =
    deps.publicBaseUrl ?? process.env.AEOLUS_PUBLIC_BASE_URL ?? 'http://localhost:5173';

  const context: ServerContext = {
    db: deps.db,
    blobs: deps.blobs,
    sessions: createSessionStore(deps.db),
    cookieSecure: deps.cookieSecure ?? false,
    cookieDomain: deps.cookieDomain,
    mail: deps.mail,
    publicBaseUrl,
    compileBoss: deps.compileBoss ?? null,
    presignCompiledPdf: deps.presignCompiledPdf,
    rateLimits: deps.browserRateLimits ?? BROWSER_RATE_LIMITS,
  };

  app.decorate('ctx', context);

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if ((err.statusCode ?? 500) >= 500) {
      request.log.error({ err }, 'request failed');
    }
    // Mask only what we did not intend to say (publicError): a deliberate
    // domain response passes through, Fastify's own FST_ERR_* codes are
    // mapped to house codes, and an unexpected 5xx reveals nothing.
    const pub = publicError(err);

    // A domain error may also carry extra contract fields (e.g. `children` on
    // folder_not_empty, which the UI renders).
    const payload =
      !pub.hide && typeof (err as { payload?: unknown }).payload === 'object'
        ? ((err as { payload?: Record<string, unknown> }).payload ?? {})
        : {};
    reply.status(pub.status).send({ error: pub.code, message: pub.message, ...payload });
  });

  // /healthz at root: matches the manifest's health-check path and
  // avoids any auth / DB dependency so it stays alive when
  // downstream services degrade.
  await registerHealthRoutes(app);

  // Browsers POST CSP violation reports here — registered after
  // setErrorHandler, because Fastify binds a route's error handler when
  // the route is added; a parser-limit 413 here used to go out in
  // Fastify's default shape for exactly that reason. Reports are (application/csp-report or
  // application/reports+json). Logged at warn with the blocked URI and the
  // directive, nothing else — the body is untrusted input.
  app.addContentTypeParser(
    ['application/csp-report', 'application/reports+json'],
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, null);
      }
    },
  );
  app.post(
    '/api/csp-report',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body as
        | { 'csp-report'?: Record<string, unknown> }
        | Array<{ body?: Record<string, unknown> }>
        | null;
      const reports = Array.isArray(body)
        ? body.map((r) => r.body ?? {})
        : body && typeof body === 'object' && body['csp-report']
          ? [body['csp-report']]
          : [];
      for (const r of reports.slice(0, 5)) {
        request.log.warn(
          {
            directive:
              r['effective-directive'] ?? r['effectiveDirective'] ?? r['violated-directive'],
            blocked: String(r['blocked-uri'] ?? r['blockedURL'] ?? '').slice(0, 200),
            document: String(r['document-uri'] ?? r['documentURL'] ?? '').slice(0, 200),
          },
          'csp violation reported',
        );
      }
      return reply.status(204).send();
    },
  );

  // Everything else under /api/* so the SPA can own root for
  // client-side routes. The SPA's fetches use /api/* paths to
  // match (vite dev proxy is wired to forward /api/* unchanged).
  const enableDevRoutes =
    deps.enableDevRoutes ??
    (process.env.NODE_ENV === 'test' || process.env.AEOLUS_ENABLE_DEV_ROUTES === '1');
  await app.register(
    async (api) => {
      // Browser-plane limiter (ADR 0025): opt-in per route via
      // `config.rateLimit`, so only the four routes that name a budget in
      // middleware/rate-limits.ts are metered. Scope-encapsulated like the
      // v1 plane's, so neither limiter sees the other's routes.
      await api.register(rateLimit, {
        global: false,
        errorResponseBuilder: (_request, context) =>
          rateLimitedResponse(context.max, context.after),
      });
      await registerAuthRoutes(api);
      await registerMeRoutes(api);
      await registerTokenRoutes(api);
      await registerAdminRoutes(api);
      await registerAdminUserRoutes(api);
      await registerAdminAuditRoutes(api);
      await registerAdminDiagnosticsRoutes(api);
      await registerDocRoutes(api);
      await registerTemplateRoutes(api);
      await registerCompileRoutes(api);
      await registerCheckpointRoutes(api);
      await registerProjectCheckpointRoutes(api);
      await registerProjectZipRoutes(api);
      await registerAssetRoutes(api);
      await registerFileRoutes(api);
      await registerAiRoutes(api);
      await registerWsTicketRoutes(api);
      if (enableDevRoutes) {
        await registerDevRoutes(api);
      }
    },
    { prefix: '/api' },
  );

  // The machine plane. A SIBLING of the /api block above, not nested inside
  // it — see registerV1 for why the encapsulation boundary matters. It must
  // also be registered BEFORE the static plugin below, so that plugin cannot
  // shadow a v1 route.
  await app.register(registerV1, { prefix: '/api/v1' });

  // Static SPA serving — Dockerfile.api builds apps/web into
  // /app/apps/web/dist and copies it into the runtime image. When
  // the dist path is present we serve assets from it, with a
  // notFoundHandler that returns index.html for non-API GETs so
  // client-side routing (React Router) handles the URL.
  const webDistPath =
    deps.webDistPath !== undefined
      ? deps.webDistPath
      : existsSync('/app/apps/web/dist')
        ? '/app/apps/web/dist'
        : null;

  if (webDistPath) {
    // The SPA shell is stamped on its way out: data-theme from the aeolus_theme
    // cookie, so the first paint is already in the right theme with no flash,
    // and the runtime config, so one image serves any hostname. See appearance.ts.
    //
    // It has to happen on BOTH paths that emit the shell: `/` (which
    // fastify-static would otherwise serve itself, hence index: false) and the
    // SPA fallback for client-side routes. Miss the second and a deep link like
    // /docs/:id renders unthemed while / renders correctly.
    const shellPath = join(webDistPath, 'index.html');
    // Cached in production, where the image is immutable and re-reading the file
    // on every navigation is waste. NOT cached otherwise: a dev who rebuilds the
    // SPA would keep being served the previous shell, whose hashed asset URLs no
    // longer exist — a blank page with no error in it.
    const cacheShell = process.env.NODE_ENV === 'production';
    // Read once: the environment does not change under a running process, and
    // the shell is rewritten on every request.
    const runtimeConfig = deps.runtimeConfig ?? runtimeConfigFromEnv();
    let shell: string | null = null;
    const sendShell = (request: FastifyRequest, reply: FastifyReply) => {
      if (shell === null || !cacheShell) shell = readFileSync(shellPath, 'utf8');
      return (
        reply
          .type('text/html; charset=utf-8')
          // The shell now varies by cookie, so a shared cache must not hand one
          // person's theme to the next.
          .header('cache-control', 'no-cache, private')
          .header('vary', 'Cookie')
          .send(stampConfig(stampTheme(shell, readTheme(request.headers.cookie)), runtimeConfig))
      );
    };

    // decorateReply must stay on (the default) so reply.sendFile stays
    // available for any other static needs.
    await app.register(staticPlugin, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
      // index: false so fastify-static does not serve index.html itself and
      // bypass the stamping. Hashed asset files still come from here.
      index: false,
    });

    app.get('/', sendShell);

    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || isApiPath(request.url)) {
        return reply.status(404).send({ error: 'not_found', message: 'Not found' });
      }
      return sendShell(request, reply);
    });
  }

  return app;
}
