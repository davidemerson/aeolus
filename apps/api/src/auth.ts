import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { users } from '@aeolus/db';

import { sessionConstants, sessionCookieOptions, type SessionRecord } from './session.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  /** Still on a system-generated credential — see middleware/require-user.ts. */
  mustSetPassphrase: boolean;
}

export async function resolveSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionRecord | null> {
  const cookieVal = request.cookies[sessionConstants.COOKIE_NAME];
  if (!cookieVal) return null;
  const unsigned = request.unsignCookie(cookieVal);
  if (!unsigned.valid || unsigned.value === null) return null;
  const rotated = await app.ctx.sessions.touch(unsigned.value);
  if (!rotated) return null;
  reply.setCookie(
    sessionConstants.COOKIE_NAME,
    rotated.token,
    sessionCookieOptions(app.ctx.cookieSecure, app.ctx.cookieDomain),
  );
  return rotated.record;
}

export async function resolveUser(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedUser | null> {
  const record = await resolveSession(app, request, reply);
  if (!record) return null;
  const [user] = await app.ctx.db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      mustSetPassphrase: users.mustSetPassphrase,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.id, record.userId))
    .limit(1);
  if (!user) return null;
  // Disabled users 401 on every request. We don't bother revoking
  // their session rows on disable — this check is the gate.
  if (user.disabledAt !== null) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    mustSetPassphrase: user.mustSetPassphrase,
  };
}
