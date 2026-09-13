import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { users } from '@aeolus/db';

import { resolveUser } from '../auth.js';
import { sessionConstants, sessionCookieOptions } from '../session.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { updateSelf } from '../services/users.js';

const PatchMeBody = z.object({ name: z.string().min(1).max(200) });

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (request, reply) => {
    // resolveUser is the single gate: it touches the session,
    // looks up the user, and rejects disabled accounts. Using
    // resolveSession + a separate user lookup here would bypass
    // the disabled_at check.
    const user = await resolveUser(app, request, reply);
    if (!user) {
      return reply.status(401).send({ error: 'unauthenticated', message: 'Not signed in' });
    }
    return reply.send({ user });
  });

  // PATCH /me — change your own display name. This route did not exist, but
  // apps/web/src/routes/settings.tsx has always called it: the Settings page's
  // Save button 404'd, silently, for as long as the page has been there.
  //
  // Email is not editable here; an administrator changes it.
  app.patch('/me', async (request, reply) => {
    const user = await resolveUser(app, request, reply);
    if (!user) {
      return reply.status(401).send({ error: 'unauthenticated', message: 'Not signed in' });
    }
    const body = PatchMeBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', message: 'name is required' });
    }
    const actor = sessionActor(user);
    const updated = await updateSelf(serviceContext(app, request, actor), actor, body.data);
    // updateSelf returns the v1 wire shape; this plane speaks camelCase and
    // the client re-reads /me straight after, so echo GET /me's shape.
    return reply.send({ user: { ...user, name: updated.name } });
  });

  // DELETE /me/session — sign-out: server-side destroy of the current
  // session row + clear the cookie. Idempotent: callers without a valid
  // cookie still get 200 so the UI can fire-and-forget the request as
  // part of any sign-out flow without special-casing.
  app.delete('/me/session', async (request, reply) => {
    const cookieVal = request.cookies[sessionConstants.COOKIE_NAME];
    let actorId: string | null = null;
    let actor: ReturnType<typeof sessionActor> | null = null;
    if (cookieVal) {
      const unsigned = request.unsignCookie(cookieVal);
      if (unsigned.valid && unsigned.value !== null) {
        const session = await app.ctx.sessions.get(unsigned.value);
        if (session) {
          actorId = session.userId;
          const [u] = await app.ctx.db
            .select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);
          if (u) actor = sessionActor(u);
        }
        await app.ctx.sessions.destroy(unsigned.value);
      }
    }
    reply.clearCookie(
      sessionConstants.COOKIE_NAME,
      sessionCookieOptions(app.ctx.cookieSecure, app.ctx.cookieDomain),
    );
    if (actorId && actor) {
      await serviceContext(app, request, actor).audit({
        action: 'auth.logout',
        resourceType: 'session',
        resourceId: actorId,
      });
    }
    return reply.status(204).send();
  });
}
