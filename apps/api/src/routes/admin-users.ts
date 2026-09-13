import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { redactEmail } from '../mail.js';
import { requireUser } from '../middleware/require-user.js';
import { serviceContext, sessionActor } from '../services/context.js';
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassphrase,
  setUserDisabled,
  updateUser,
} from '../services/users.js';
import { sendError, notFound } from '../middleware/reply-errors.js';

/**
 * The browser plane's user administration — thin callers over
 * `services/users.ts`, which `/api/v1` also uses.
 *
 * Admin-gating moved into the service, so the `requireAdmin` preHandler is
 * gone: a non-admin gets the same `403 forbidden` from one place, on either
 * plane.
 */

const UserIdParams = z.object({ id: z.string().uuid() });
const CreateUserBody = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200).optional(),
  isAdmin: z.boolean().optional(),
});
const PatchUserBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    isAdmin: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.isAdmin !== undefined, {
    message: 'name or isAdmin is required',
  });

export async function registerAdminUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/users', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const actor = sessionActor(user);
    return reply.send({ users: await listUsers(serviceContext(app, request, actor), actor) });
  });

  // Returns the generated passphrase in the body. It is the only time it
  // exists in readable form; the admin passes it to the new user out of band.
  app.post('/admin/users', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const body = CreateUserBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', body.error.issues[0].message);
    }
    const actor = sessionActor(user);
    const created = await createUser(serviceContext(app, request, actor), actor, body.data);
    const { passphrase, ...view } = created;
    return reply.status(201).send({ user: view, passphrase });
  });

  app.post('/admin/users/:id/reset-passphrase', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = UserIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const { passphrase } = await resetUserPassphrase(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
    );
    return reply.send({ passphrase });
  });

  app.patch('/admin/users/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = UserIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = PatchUserBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', body.error.issues[0].message);
    }
    const actor = sessionActor(user);
    const updated = await updateUser(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      body.data,
    );
    return reply.send({ user: updated });
  });

  app.delete('/admin/users/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = UserIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const result = await deleteUser(serviceContext(app, request, actor), actor, parsed.data.id);
    request.log.info(
      {
        deleted: redactEmail(result.email),
        docs_transferred: result.transferred,
        new_owner: actor.id,
      },
      'admin deleted user',
    );
    return reply.status(204).send();
  });

  for (const disabled of [true, false] as const) {
    app.post(`/admin/users/:id/${disabled ? 'disable' : 'enable'}`, async (request, reply) => {
      const user = await requireUser(app, request, reply);
      if (!user) return;
      const parsed = UserIdParams.safeParse(request.params);
      if (!parsed.success) return notFound(reply);
      const actor = sessionActor(user);
      await setUserDisabled(serviceContext(app, request, actor), actor, parsed.data.id, disabled);
      return reply.status(204).send();
    });
  }
}
