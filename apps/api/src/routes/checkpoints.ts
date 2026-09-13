import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import {
  createCheckpoint,
  getCheckpoint,
  listCheckpoints,
  openCheckpoint,
  restoreCheckpoint,
} from '../services/checkpoints.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { sendError, notFound } from '../middleware/reply-errors.js';

/**
 * Per-file version history — thin callers over `services/checkpoints.ts`,
 * which `/api/v1` also uses.
 */

const DocIdParams = z.object({ id: z.string().uuid() });
const CheckpointParams = z.object({
  id: z.string().uuid(),
  checkpointId: z.string().uuid(),
});
// Two flavours share one body: a user-named checkpoint, or an auto-open one
// where the server fabricates the label and applies the coalescing window.
const CreateCheckpointBody = z.union([
  z.object({ label: z.string().min(1).max(120), auto: z.literal(false).optional() }),
  z.object({ auto: z.literal(true), label: z.string().min(1).max(120).optional() }),
]);
// safeParse'd so a malformed value 404s rather than throwing.
const FileIdQuery = z.object({ fileId: z.string().uuid().optional() });

function fileIdOf(request: { query?: unknown }): string | null {
  const parsed = FileIdQuery.safeParse(request.query ?? {});
  return parsed.success ? (parsed.data.fileId ?? null) : null;
}

export async function registerCheckpointRoutes(app: FastifyInstance): Promise<void> {
  app.post('/docs/:id/checkpoints', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = CreateCheckpointBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', 'label is required (1-120 chars)');
    }
    const actor = sessionActor(user);
    const result = await createCheckpoint(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      {
        label: 'label' in body.data ? body.data.label : undefined,
        auto: 'auto' in body.data ? body.data.auto === true : false,
        fileId: fileIdOf(request),
      },
    );
    // A coalesced auto-open is a 200 no-op, not a creation.
    if ('skipped' in result) return reply.send(result);
    return reply.status(201).send({ checkpoint: result });
  });

  app.get('/docs/:id/checkpoints', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const checkpoints = await listCheckpoints(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      fileIdOf(request),
      (err) => request.log.warn({ err }, 'auto-open checkpoint retention sweep failed'),
    );
    return reply.send({ checkpoints });
  });

  app.get('/docs/:id/checkpoints/:checkpointId', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = CheckpointParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const checkpoint = await getCheckpoint(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.checkpointId,
    );
    return reply.send({ checkpoint });
  });

  app.get('/docs/:id/checkpoints/:checkpointId/download', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = CheckpointParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const obj = await openCheckpoint(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.checkpointId,
    );
    reply.header('content-type', 'application/octet-stream');
    if (obj.contentLength != null) reply.header('content-length', obj.contentLength);
    return reply.send(obj.body);
  });

  app.post('/docs/:id/checkpoints/:checkpointId/restore', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = CheckpointParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const result = await restoreCheckpoint(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.checkpointId,
      (err) => request.log.warn({ err }, 'room_evict NOTIFY failed after checkpoint restore'),
    );
    return reply.send(result);
  });
}
