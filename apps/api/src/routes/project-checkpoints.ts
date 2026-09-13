import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import {
  createProjectCheckpoint,
  deleteProjectCheckpoint,
  listProjectCheckpoints,
  restoreProjectCheckpoint,
} from '../services/checkpoints.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { sendError, notFound } from '../middleware/reply-errors.js';

/**
 * Whole-project version history — thin callers over
 * `services/checkpoints.ts`, which `/api/v1` also uses.
 */

const DocIdParams = z.object({ id: z.string().uuid() });
const ProjectCheckpointParams = z.object({
  id: z.string().uuid(),
  projectCheckpointId: z.string().uuid(),
});
const CreateProjectCheckpointBody = z.object({ label: z.string().min(1).max(120) });

export async function registerProjectCheckpointRoutes(app: FastifyInstance): Promise<void> {
  app.post('/docs/:id/project-checkpoints', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = CreateProjectCheckpointBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', 'label is required (1-120 chars)');
    }
    const actor = sessionActor(user);
    const project_checkpoint = await createProjectCheckpoint(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      body.data,
    );
    return reply.status(201).send({ project_checkpoint });
  });

  app.get('/docs/:id/project-checkpoints', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const project_checkpoints = await listProjectCheckpoints(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
    );
    return reply.send({ project_checkpoints });
  });

  app.post('/docs/:id/project-checkpoints/:projectCheckpointId/restore', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = ProjectCheckpointParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const result = await restoreProjectCheckpoint(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.projectCheckpointId,
      (err, yjsDocId) =>
        request.log.warn(
          { err, yjsDocId },
          'room_evict NOTIFY failed after project-checkpoint restore',
        ),
    );
    return reply.send(result);
  });

  app.delete('/docs/:id/project-checkpoints/:projectCheckpointId', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = ProjectCheckpointParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    await deleteProjectCheckpoint(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.projectCheckpointId,
    );
    return reply.status(204).send();
  });
}
