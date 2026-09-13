import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { resolveUser, type AuthenticatedUser } from '../auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: AuthenticatedUser;
  }
}

export type RequireAdminHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function makeRequireAdmin(app: FastifyInstance): RequireAdminHook {
  return async function requireAdmin(request, reply) {
    const user = await resolveUser(app, request, reply);
    if (!user) {
      await reply.status(401).send({ error: 'unauthenticated', message: 'Not signed in' });
      return;
    }
    if (!user.isAdmin) {
      await reply.status(403).send({ error: 'forbidden', message: 'Admin access required' });
      return;
    }
    // An admin still on a generated credential sets their own passphrase
    // before they can administer anything (see require-user.ts).
    if (user.mustSetPassphrase) {
      await reply.status(403).send({
        error: 'passphrase_setup_required',
        message: 'Choose your own passphrase before using Aeolus.',
      });
      return;
    }
    request.adminUser = user;
  };
}
