import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { createFile, deleteFile, listFiles, renameFile, uploadFile } from '../services/files.js';
import { sendError, notFound } from '../middleware/reply-errors.js';
import { drainUpload } from '../middleware/upload.js';

/**
 * The browser plane's project-file routes — thin callers over
 * `services/files.ts`, which `/assets` and `/api/v1` also use.
 *
 * What is left here is genuinely HTTP: parsing, draining the multipart
 * stream, and choosing a success status. Errors are thrown by the service and
 * rendered by the global handler.
 */

const DocIdParams = z.object({ id: z.string().uuid() });
const FileParams = z.object({ id: z.string().uuid(), fileId: z.string().uuid() });
const CreateTextFileBody = z.object({
  path: z.string().min(1).max(1024),
  kind: z.enum(['text', 'folder']).optional(),
});
const RenameFileBody = z.object({ path: z.string().min(1).max(1024) });

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/docs/:id/files', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const files = await listFiles(serviceContext(app, request, actor), actor, parsed.data.id);
    return reply.send({ files });
  });

  app.post('/docs/:id/files', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = CreateTextFileBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'invalid_body', 'path is required');
    const actor = sessionActor(user);
    const file = await createFile(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      body.data,
    );
    return reply.status(201).send({ file });
  });

  app.post('/docs/:id/files/upload', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    // `read` is deferred so the service authorizes before the multipart stream
    // is touched — see uploadFile.
    const file = await uploadFile(serviceContext(app, request, actor), actor, parsed.data.id, {
      read: () => drainUpload(request),
    });
    return reply.status(201).send({
      file: {
        id: file.id,
        path: file.path,
        kind: 'blob' as const,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        // asset_id mirrors id, for callers written against the pre-#35
        // /assets surface.
        asset_id: file.id,
        created_at: file.created_at,
      },
    });
  });

  app.patch('/docs/:id/files/:fileId', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = FileParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = RenameFileBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'invalid_body', 'path is required');
    const actor = sessionActor(user);
    const file = await renameFile(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.fileId,
      body.data.path,
    );
    return reply.send({ file });
  });

  app.delete('/docs/:id/files/:fileId', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = FileParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    await deleteFile(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.fileId,
    );
    return reply.status(204).send();
  });
}
