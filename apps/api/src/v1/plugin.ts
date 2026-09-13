import { createHash } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import type { FastifyError, FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { bearerFrom } from '../auth/tokens.js';
import { rateLimitedResponse } from '../middleware/rate-limits.js';
import { publicError } from '../middleware/reply-errors.js';
import { makeV1AuthHook } from './authenticate.js';
import { enforceDocumentedRoutes, registerOpenApi } from './openapi.js';
import { registerV1DocRoutes } from './routes/docs.js';
import { registerV1FileRoutes } from './routes/files.js';
import { registerV1CheckpointRoutes } from './routes/checkpoints.js';
import { registerV1CompileRoutes } from './routes/compile.js';
import { registerV1TemplateRoutes } from './routes/templates.js';
import { registerV1AdminRoutes } from './routes/admin.js';
import { registerV1AiRoutes } from './routes/ai.js';
import { registerV1WsRoutes } from './routes/ws.js';
import { registerV1MeRoutes } from './routes/me.js';

/**
 * Per-credential rate limits, in requests per minute.
 *
 * These live in the app rather than in whatever sits in front of it. A
 * proxy-level IP rate rule meters every caller behind the proxy as one source,
 * and the forwarded-header alternative keys on a header the caller can write
 * to. The app is the only place that knows who is actually asking.
 */
export const V1_RATE_LIMITS = {
  /** Everything without a more specific budget. */
  default: 120,
} as const;

/**
 * The `/api/v1` machine plane.
 *
 * Registered as a SIBLING of the existing `/api` block in server.ts, not
 * nested inside it. That matters: this plugin installs an `onRequest` auth
 * hook and (from the OpenAPI work) its own validator/serializer compilers, and
 * Fastify encapsulation is what keeps all of them off the browser plane.
 * Nesting would work today only because that block happens to have no hooks.
 */
export async function registerV1(app: FastifyInstance): Promise<void> {
  // Validate and serialize from the same zod schemas the OpenAPI description is
  // generated from. Both compilers are scope-encapsulated, so the browser plane
  // keeps Fastify's default ajv — which it has never used, and which would
  // otherwise choke on a zod object handed to it.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Rate-limit the whole plane.
  //
  // `global: true` is safe here and is what makes coverage structural rather
  // than remembered: @fastify/rate-limit is fastify-plugin-wrapped, so it
  // attaches to the scope it is registered in — this encapsulated v1 plugin —
  // not to the root. Its hook therefore runs for v1 routes and no others,
  // which `v1.ratelimit.test.ts` pins by hammering the cookie plane.
  //
  // The per-route `onRoute`-stamping alternative was tried first and quietly
  // did nothing: @fastify/rate-limit decides per route inside its own onRoute
  // hook, and it wins the ordering regardless of when ours is added, so every
  // route came out unlimited with no error to notice.
  await app.register(rateLimit, {
    global: true,
    max: V1_RATE_LIMITS.default,
    timeWindow: '1 minute',
    keyGenerator(request) {
      const bearer = bearerFrom(request.headers.authorization);
      // Bucket on a hash of the credential, never the credential itself — the
      // key reaches the limiter's store and, on a 429, the logs.
      return bearer
        ? `t:${createHash('sha256').update(bearer).digest('hex').slice(0, 32)}`
        : `ip:${request.ip}`;
    },
    errorResponseBuilder(_request, context) {
      // statusCode matters: this object is surfaced as an error, and without
      // it the error handler cannot tell 429 from a server fault. Before it
      // was added, every rate-limited request answered 500 internal_error.
      return rateLimitedResponse(context.max, context.after);
    },
  });

  // A v1-scoped error handler, so the plane's failures keep the house envelope
  // instead of falling through to the global handler, which masks anything it
  // cannot read a statusCode from as a 500.
  app.setErrorHandler((err: FastifyError & { error?: string }, request, reply) => {
    // A request that failed its own schema. `details` is ADDITIVE — the house
    // { error, message } envelope stays intact, so v1 is a superset of it
    // rather than a different shape.
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: "The request did not match this endpoint's schema",
        details: err.validation.map((v) => ({
          path: v.instancePath,
          message: v.message,
        })),
      });
    }

    // A RESPONSE that failed its own schema is always a server bug: we
    // promised a shape in the OpenAPI description and did not produce it.
    // Log it loudly and tell the client nothing.
    if (isResponseSerializationError(err)) {
      request.log.error(
        { err, route: request.routeOptions.url },
        'v1 response failed its own schema',
      );
      return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
    }

    if ((err.statusCode ?? 500) >= 500) request.log.error({ err }, 'v1 request failed');

    // Mask only what we did not intend to say (publicError). An error carrying
    // BOTH an explicit statusCode and a code is a deliberate domain response —
    // a 503 `compile_unavailable` is as much a part of the contract as a 404 —
    // and flattening it to `internal_error` both loses information the caller
    // needs and, because the route declares a schema for it, fails
    // serialization and turns itself into a 500. Fastify's own FST_ERR_*
    // codes (a body over the limit, a bad content-type) are mapped to the
    // house codes the routes declare. Anything else at 5xx says nothing.
    const pub = publicError(err);

    const payload =
      !pub.hide && typeof (err as { payload?: unknown }).payload === 'object'
        ? ((err as { payload?: Record<string, unknown> }).payload ?? {})
        : {};
    return reply.status(pub.status).send({ error: pub.code, message: pub.message, ...payload });
  });

  app.addHook('onRequest', makeV1AuthHook(app));

  // Scope the not-found handler to this plugin, so an unmatched path under
  // /api/v1 is handled INSIDE the plane rather than by the root handler.
  //
  // This is a correctness fix, not tidiness. Fastify only runs a scope's
  // onRequest hooks for requests that reach that scope, and a request matching
  // no route never does — so without this, `GET /api/v1/anything` answered 404
  // to an anonymous caller, telling them which routes exist before asking for
  // a credential, and a read-scope token's `POST /api/v1/anything` returned 404
  // instead of meeting the scope gate. With the handler registered here, the
  // auth hook runs first and the plane answers 401/403 before it answers 404.
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: 'not_found', message: 'Not found' }),
  );

  await registerOpenApi(app);

  // Before the routes: onRoute fires at registration, so a hook added after
  // them sees nothing and the check would silently pass.
  enforceDocumentedRoutes(app);

  await registerV1MeRoutes(app);
  await registerV1DocRoutes(app);
  await registerV1FileRoutes(app);
  await registerV1TemplateRoutes(app);
  await registerV1CompileRoutes(app);
  await registerV1CheckpointRoutes(app);
  await registerV1AdminRoutes(app);
  await registerV1AiRoutes(app);
  await registerV1WsRoutes(app);
}
