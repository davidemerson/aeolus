import { eq } from 'drizzle-orm';
import type { FastifyInstance, onRequestHookHandler, FastifyRequest } from 'fastify';

import { users, type Database } from '@aeolus/db';

import type { Actor } from '../actor.js';
import { bearerFrom, parseTokenId, scopeAllows, tokenMatches } from '../auth/tokens.js';
import { findTokenForAuth, touchToken } from '../services/tokens.js';

/**
 * Distinguishes "your credential is wrong" from "we could not check it".
 * Every credential is now a database row, so an RDS failover has to answer
 * something retryable rather than authenticating from memory — and a client
 * that treats a transient 401 as "my token was revoked" will throw away a
 * perfectly good credential.
 */
const UNAVAILABLE = Symbol('token store unavailable');

export interface TokenCaller {
  actor: Actor;
  scope: 'read' | 'write';
}

export async function authenticateToken(
  db: Database,
  presented: string,
): Promise<TokenCaller | null | typeof UNAVAILABLE> {
  // Shape check first: a flood of junk Authorization headers costs no queries.
  const id = parseTokenId(presented);
  if (id === null) return null;

  let row: Awaited<ReturnType<typeof findTokenForAuth>>;
  try {
    row = await findTokenForAuth(db, id);
  } catch {
    return UNAVAILABLE;
  }
  if (!row) return null;
  if (!tokenMatches(presented, row.tokenHash)) return null;

  // A token acts as the user who minted it, so the user must still be able to
  // act. This mirrors resolveUser's disabled check exactly — disabling someone
  // has to kill their tokens as well as their sessions, or "disabled" would
  // mean only "cannot use the browser".
  let owner:
    | {
        id: string;
        email: string;
        name: string | null;
        isAdmin: boolean;
        disabledAt: Date | null;
        mustSetPassphrase: boolean;
      }
    | undefined;
  try {
    [owner] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isAdmin: users.isAdmin,
        disabledAt: users.disabledAt,
        mustSetPassphrase: users.mustSetPassphrase,
      })
      .from(users)
      .where(eq(users.id, row.createdBy))
      .limit(1);
  } catch {
    return UNAVAILABLE;
  }
  if (!owner || owner.disabledAt !== null) return null;
  // A token belongs to its minting user, so a user who has not yet chosen
  // their own passphrase cannot act through one either.
  if (owner.mustSetPassphrase) return null;

  const scope = row.scope === 'write' ? 'write' : 'read';
  return {
    scope,
    actor: {
      id: owner.id,
      email: owner.email,
      name: owner.name,
      isAdmin: owner.isAdmin,
      via: { kind: 'token', tokenId: row.id, tokenName: row.name, scope },
    },
  };
}

/**
 * Paths under /api/v1 that are readable without a credential.
 *
 * The API description and its browsable reference. Requiring a token to read
 * the document that explains how to obtain one is a bootstrap loop, an API
 * description is not a secret.
 */
function isPublicV1Path(url: string): boolean {
  const path = url.split('?', 1)[0];
  return (
    path === '/api/v1/openapi.json' ||
    path === '/api/v1/openapi.yaml' ||
    path === '/api/v1/reference' ||
    path.startsWith('/api/v1/reference/')
  );
}

/**
 * The only way in to /api/v1.
 *
 * Bearer tokens only — no session cookie. Three reasons, in order of weight:
 * `resolveSession` rotates the token on every call and sets a new cookie, so a
 * cookie-authed machine client gets one request per credential; `scopeAllows`
 * is valuable precisely because it is total, and a cookie has no scope to
 * check; and with no cookie accepted, CSRF on this plane is structurally
 * impossible rather than merely mitigated.
 */
export function makeV1AuthHook(app: FastifyInstance): onRequestHookHandler {
  return async function v1Auth(request, reply) {
    if (isPublicV1Path(request.url)) return;

    const presented = bearerFrom(request.headers.authorization);
    if (presented === null) {
      await reply.status(401).send({
        error: 'unauthenticated',
        message: 'Provide a token as: Authorization: Bearer aeolus_…',
      });
      return;
    }

    const caller = await authenticateToken(app.ctx.db, presented);

    if (caller === UNAVAILABLE) {
      await reply.status(503).send({
        error: 'token_store_unavailable',
        message: 'Could not verify the token right now; retry shortly',
        retryable: true,
      });
      return;
    }
    if (caller === null) {
      await reply
        .status(401)
        .send({ error: 'unauthenticated', message: 'Invalid or revoked token' });
      return;
    }

    if (!scopeAllows(caller.scope, request.method)) {
      // 403, not 401: the credential is valid, so re-authenticating cannot fix
      // it. A client that retries 401s by fetching a new token would loop.
      await reply.status(403).send({
        error: 'read_only_token',
        message: 'This token is read-only; a write-scope token is required',
        scope: caller.scope,
      });
      return;
    }

    request.actor = caller.actor;

    // Best-effort, and deliberately not awaited into the failure path: a failed
    // last-used stamp must never fail the request it describes — but it is
    // logged, so a broken write does not go unnoticed for a month.
    if (caller.actor.via.kind === 'token') {
      void touchToken(app.ctx.db, caller.actor.via.tokenId).catch((err: unknown) => {
        request.log.warn({ err }, 'v1: touchToken failed');
      });
    }
  };
}

/**
 * The authenticated actor on a v1 request. The onRequest hook above sets it
 * before any route runs, so inside a handler it is always present; this reads
 * it without a non-null assertion at every call site (there were ~40) and
 * throws, rather than dereferencing undefined, if a route ever escapes the
 * hook.
 */
export function actorOf(request: FastifyRequest): Actor {
  const actor = request.actor;
  if (!actor) {
    throw Object.assign(new Error('v1 route reached without an authenticated actor'), {
      statusCode: 500,
    });
  }
  return actor;
}
