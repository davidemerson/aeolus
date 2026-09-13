import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import { buildProjectZip } from '../services/compile.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { notFound } from '../middleware/reply-errors.js';

const DocIdParams = z.object({ id: z.string().uuid() });

export async function registerProjectZipRoutes(app: FastifyInstance): Promise<void> {
  // GET /docs/:id/download.zip — every file in the project, zipped. Text files
  // render their current CRDT state to UTF-8; blobs copy bytes verbatim.
  app.get('/docs/:id/download.zip', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const archive = await buildProjectZip(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      (info) =>
        request.log.warn(
          { ...info, docId: parsed.data.id },
          'project-zip: blob missing for doc_files row',
        ),
    );
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', archive.bytes.length)
      .header('content-disposition', `attachment; filename="${archive.filename}"`)
      .header('cache-control', 'private, max-age=0, must-revalidate')
      .send(archive.bytes);
  });
}
