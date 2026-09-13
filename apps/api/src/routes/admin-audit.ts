import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import { listAuditEvents } from '../services/audit-events.js';
import { serviceContext, sessionActor } from '../services/context.js';

const ListQuery = z.object({
  action: z.string().min(1).max(64).optional(),
  actor_id: z.string().uuid().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export async function registerAdminAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/audit-events', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'invalid_query', message: parsed.error.issues[0].message });
    }
    const actor = sessionActor(user);
    const page = await listAuditEvents(serviceContext(app, request, actor), actor, {
      action: parsed.data.action,
      actorId: parsed.data.actor_id,
      before: parsed.data.before,
      limit: parsed.data.limit,
    });
    return reply.send(page);
  });
}
