import { z } from 'zod';

/**
 * Shared response shapes for the `/api/v1` plane.
 *
 * Registering a schema in `z.globalRegistry` with an `id` is what makes
 * `@fastify/swagger` emit it once under `components.schemas` and `$ref` it from
 * every operation, instead of inlining a copy per route. Anything reused across
 * two or more routes belongs here; a one-off shape can stay inline.
 */

export const ErrorResponse = z
  .object({
    /**
     * Stable, machine-readable. This is the field a client should branch on —
     * `message` is for humans and may be reworded without notice.
     */
    error: z.string(),
    message: z.string(),
  })
  .meta({
    id: 'ErrorResponse',
    description: 'The uniform error envelope used by every route on this plane.',
  });

export const RateLimitedResponse = ErrorResponse.meta({
  id: 'RateLimitedResponse',
  description: 'Rate limit exceeded. Honour the `retry-after` header.',
});

export const ReadOnlyTokenResponse = z
  .object({
    error: z.literal('read_only_token'),
    message: z.string(),
    scope: z.literal('read'),
  })
  .meta({
    id: 'ReadOnlyTokenResponse',
    description:
      'The credential is valid but read-scope, and the method is a write. 403 rather ' +
      'than 401 is deliberate: re-authenticating cannot fix it, so a client that ' +
      'retries 401s by fetching a new token would loop forever.',
  });

/**
 * 503 has two causes on this plane, so the schema admits both. It was one
 * `z.literal('token_store_unavailable')` until the compile plane's
 * `compile_unavailable` failed its own response schema and the serializer
 * turned a legitimate 503 into a 500 — the response schema catching a
 * mismatch between what a route declares and what it does, which is what it
 * is for.
 *
 * Branch on `error`:
 *   token_store_unavailable — the credential could not be CHECKED. Distinct
 *     from 401 on purpose: a client that reads a transient 401 as "revoked"
 *     throws away a working token.
 *   compile_unavailable — the compile queue is not configured.
 */
export const TokenStoreUnavailableResponse = z
  .object({
    error: z.enum(['token_store_unavailable', 'compile_unavailable']),
    message: z.string(),
    retryable: z.boolean().optional().describe('Present and true when a retry may succeed.'),
  })
  .meta({
    id: 'ServiceUnavailableResponse',
    description: 'The request could not be served right now. Branch on `error`.',
  });

/**
 * The standard failure responses every authenticated v1 route can produce, so
 * each route declares them by spreading rather than restating them.
 *
 * `404` is deliberately not in here: it means different things on different
 * routes (no such route, versus a document the caller's user cannot see, per
 * ADR 0003), so each route that can 404 says what it means.
 */
export function errorResponses() {
  return {
    401: ErrorResponse,
    403: ReadOnlyTokenResponse,
    429: RateLimitedResponse,
    503: TokenStoreUnavailableResponse,
  } as const;
}

export const TokenSummary = z
  .object({
    id: z.string().describe('The public half of the credential. Safe to log.'),
    name: z.string(),
    scope: z.enum(['read', 'write']),
  })
  .meta({ id: 'TokenSummary' });

export const UserSummary = z
  .object({
    id: z.uuid(),
    email: z.string(),
    name: z.string().nullable(),
    is_admin: z.boolean(),
  })
  .meta({ id: 'UserSummary' });

/** A user as the API returns it after a write — `UserSummary` plus the one
 *  piece of state an admin acts on. Shared by `PATCH /me` and the admin
 *  routes so the two cannot describe the same row differently. */
export const UserRecord = UserSummary.extend({
  disabled_at: z
    .string()
    .nullable()
    .describe('When set, every session AND every API token of theirs is refused.'),
}).meta({ id: 'UserRecord' });
