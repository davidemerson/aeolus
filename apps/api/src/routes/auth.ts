import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { PASSPHRASE_RULE, generatePassphrase, sessionConstants } from '@aeolus/auth';

import { sessionCookieOptions } from '../session.js';
import { requireUser } from '../middleware/require-user.js';
import { sendError } from '../middleware/reply-errors.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { authenticate, setPassphrase } from '../services/credentials.js';

// Sign-in for the browser plane. Aeolus authenticates people locally with a
// passphrase; there is no identity provider to configure and no outbound mail
// to arrange. The credential rules live in packages/auth/src/passphrase.ts.

const LoginBody = z.object({
  email: z.string().min(3).max(320),
  passphrase: z.string().min(1).max(1024),
});

const SetPassphraseBody = z.object({
  current: z.string().max(1024).optional(),
  next: z.string().min(1).max(1024),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /auth/policy — what the setup screen prints, so the rule text lives in
  // one place and the UI cannot drift from the server that enforces it.
  app.get('/auth/policy', async (_request, reply) =>
    reply.send({ rule: PASSPHRASE_RULE, suggestion: generatePassphrase() }),
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: app.ctx.rateLimits.login } },
    async (request, reply) => {
      const parsed = LoginBody.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'invalid_body', 'Provide an email and a passphrase.');
      }

      // Throws InvalidCredentialsError / AccountLockedError / AccountDisabledError,
      // which the global handler renders — they carry statusCode and code.
      const identity = await authenticate(app.ctx.db, parsed.data);

      const { token } = await app.ctx.sessions.create(identity.id);
      reply.setCookie(
        sessionConstants.COOKIE_NAME,
        token,
        sessionCookieOptions(app.ctx.cookieSecure, app.ctx.cookieDomain),
      );

      await serviceContext(app, request, sessionActor(identity)).audit({
        action: 'auth.login',
        resourceType: 'session',
        resourceId: identity.id,
      });

      return reply.send({
        user: {
          id: identity.id,
          email: identity.email,
          name: identity.name,
          is_admin: identity.isAdmin,
        },
        must_set_passphrase: identity.mustSetPassphrase,
      });
    },
  );

  // POST /auth/passphrase — set or change it. Reachable while the caller is
  // still on a generated credential, which is the one route that is (see
  // middleware/require-user.ts).
  app.post(
    '/auth/passphrase',
    { config: { rateLimit: app.ctx.rateLimits.login } },
    async (request, reply) => {
      const user = await requireUser(app, request, reply);
      if (!user) return;

      const parsed = SetPassphraseBody.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'invalid_body', 'Provide the new passphrase.');
      }

      await setPassphrase(app.ctx.db, user.id, parsed.data);

      await serviceContext(app, request, sessionActor(user)).audit({
        action: 'auth.passphrase_set',
        resourceType: 'user',
        resourceId: user.id,
      });

      return reply.status(204).send();
    },
  );
}
