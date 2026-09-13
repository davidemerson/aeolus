import type { AuthenticatedUser } from './auth.js';

/**
 * Who is making a request, and by what means.
 *
 * The `via` discriminator exists so audit rows and log lines can say whether a
 * change came from a person in the editor or from automation, without the
 * routes having to care which. Everything else about an actor is identical
 * across the two: a token acts AS the user who minted it, so `id`, `email` and
 * `isAdmin` mean exactly what they mean for a session, and the document ACL
 * applies unchanged.
 *
 * `mustSetPassphrase` is deliberately not carried here: it gates whether a
 * request gets past the middleware at all, and by the time an Actor exists
 * that question has already been answered.
 */
export interface Actor extends Omit<AuthenticatedUser, 'mustSetPassphrase'> {
  via:
    | { kind: 'session' }
    | { kind: 'token'; tokenId: string; tokenName: string; scope: 'read' | 'write' };
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}
