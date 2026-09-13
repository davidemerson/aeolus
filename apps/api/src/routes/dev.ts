import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { MemoryMailAdapter } from '../mail.js';
import { sessionConstants, sessionCookieOptions } from '../session.js';
import { ensureUserByEmail } from '../services/users.js';

const CreateUserBody = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  isAdmin: z.boolean().optional(),
});

const CreateSessionBody = z.object({
  userId: z.string().uuid(),
});

export async function registerDevRoutes(app: FastifyInstance): Promise<void> {
  app.post('/dev/users', async (request, reply) => {
    const parsed = CreateUserBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Invalid body' });
    }
    // Same find-or-create the admin bot mint uses (services/users.ts); a
    // repeated email returns the existing row instead of a unique-violation 500.
    const { created: _created, ...row } = await ensureUserByEmail(app.ctx.db, {
      email: parsed.data.email,
      name: parsed.data.name ?? null,
      isAdmin: parsed.data.isAdmin ?? false,
    });
    return reply.status(201).send(row);
  });

  app.post('/dev/sessions', async (request, reply) => {
    const parsed = CreateSessionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Invalid body' });
    }
    const { token } = await app.ctx.sessions.create(parsed.data.userId);
    reply.setCookie(
      sessionConstants.COOKIE_NAME,
      token,
      sessionCookieOptions(app.ctx.cookieSecure, app.ctx.cookieDomain),
    );
    return reply.status(201).send({ ok: true });
  });

  app.get('/dev/mail', async (_request, reply) => {
    const mail = app.ctx.mail;
    if (!(mail instanceof MemoryMailAdapter)) {
      return reply
        .status(400)
        .send({ error: 'unsupported', message: 'Mail adapter is not MemoryMailAdapter' });
    }
    return reply.send({ messages: mail.sent });
  });

  app.delete('/dev/mail', async (_request, reply) => {
    const mail = app.ctx.mail;
    if (mail instanceof MemoryMailAdapter) {
      mail.reset();
    }
    return reply.status(204).send();
  });
}
