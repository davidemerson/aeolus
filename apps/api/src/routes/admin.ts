import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { makeRequireAdmin } from '../middleware/require-admin.js';
import { sendError } from '../middleware/reply-errors.js';
import { ensureUserByEmail } from '../services/users.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const requireAdmin = makeRequireAdmin(app);

  // POST /admin/bot-session — mint a long-lived, non-rotating
  // session for an arbitrary email (creating the user if they don't
  // exist). Intended for operator tooling that holds a token across
  // many calls (debug-compile.mjs and friends), where the standard
  // rotate-on-touch behavior would invalidate the token between
  // hops. Standard 30-day absolute TTL still applies.
  app.post('/admin/bot-session', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = request.adminUser;
    if (!admin) {
      return sendError(reply, 401, 'unauthenticated', 'Not signed in');
    }
    const parsed = BotSessionBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_body', 'email is required');
    }
    const email = parsed.data.email.trim().toLowerCase();

    // Upsert the bot user. We don't surface a separate "is bot"
    // flag on users — the row is just a user with a name like
    // "claude-bot" that happens to never sign in interactively. The
    // distinction is enforced by humans + the call site that mints
    // the session, not by schema.
    const { id: botId } = await ensureUserByEmail(app.ctx.db, {
      email,
      name: parsed.data.name ?? null,
      isAdmin: parsed.data.is_admin ?? false,
    });

    const { token } = await app.ctx.sessions.createBot(botId);
    const signed = app.signCookie(token);
    request.log.info({ actor: admin.id, bot_user_id: botId, email }, 'admin minted a bot session');
    return reply.status(201).send({
      user_id: botId,
      cookie_name: 'aeolus_session',
      cookie_value: signed,
      cookie_header: `aeolus_session=${signed}`,
    });
  });

  // POST /admin/dev-session — mint a fresh session for the calling
  // admin and return the plaintext token. Useful for operator
  // tooling that needs to curl admin endpoints directly without a
  // browser (the session cookie is otherwise locked to the api
  // subdomain and can't be plucked out by hand). The minted token
  // has the same lifetime as a normal login — clear by signing out.
  app.post('/admin/dev-session', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = request.adminUser;
    if (!admin) {
      return sendError(reply, 401, 'unauthenticated', 'Not signed in');
    }
    const { token } = await app.ctx.sessions.create(admin.id);
    // @fastify/cookie was registered with the cookie secret in
    // server.ts, so app.signCookie(value) emits the same
    // `<value>.<HMAC>` shape the server later validates via
    // request.unsignCookie. Hand it back wrapped as a `cookie: …`
    // header so the caller can paste straight into curl.
    const signed = app.signCookie(token);
    request.log.info({ actor: admin.id }, 'admin minted a dev session via /admin/dev-session');
    return reply.status(201).send({
      cookie_name: 'aeolus_session',
      cookie_value: signed,
      cookie_header: `aeolus_session=${signed}`,
    });
  });
}

const BotSessionBody = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  is_admin: z.boolean().optional(),
});
