import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { resolveUser, type AuthenticatedUser } from '../auth.js';

/**
 * Routes a caller may still reach while their credential is one the system
 * generated: the setup endpoint itself, the rule text it prints, the identity
 * the screen renders, and the way out.
 */
const PASSPHRASE_SETUP_EXEMPT = new Set([
  '/api/auth/passphrase',
  '/api/auth/policy',
  '/api/auth/login',
  '/api/me',
  '/api/me/session',
]);

/**
 * Resolve the caller, or answer 401 and return null.
 *
 * Eight route modules each carried a byte-identical private copy of this
 * (docs, compile, files, assets, checkpoints, project-checkpoints, templates,
 * project-zip) — differing only in where prettier wrapped the `reply.send`
 * line. They are now one function.
 *
 * `resolveUser` has a side effect worth remembering at every call site: it
 * rotates the session and sets a fresh `aeolus_session` cookie. Calling it twice
 * in one request would issue two rotations, so call it once and pass the
 * result down. That is also why the passphrase-setup gate lives here rather
 * than in a hook of its own — a hook would have to resolve the session a
 * second time.
 */
export async function requireUser(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedUser | null> {
  const user = await resolveUser(app, request, reply);
  if (!user) {
    await reply.status(401).send({ error: 'unauthenticated', message: 'Not signed in' });
    return null;
  }
  if (user.mustSetPassphrase && !isSetupExempt(request)) {
    await reply.status(403).send({
      error: 'passphrase_setup_required',
      message: 'Choose your own passphrase before using Aeolus.',
    });
    return null;
  }
  return user;
}

function isSetupExempt(request: FastifyRequest): boolean {
  const routed = request.routeOptions?.url;
  if (routed && PASSPHRASE_SETUP_EXEMPT.has(routed)) return true;
  const path = (request.url || '').split('?', 1)[0];
  return PASSPHRASE_SETUP_EXEMPT.has(path);
}
