import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { deleteFile, listAssets, uploadFile } from '../services/files.js';
import { notFound } from '../middleware/reply-errors.js';
import { drainUpload } from '../middleware/upload.js';

/**
 * The legacy bare-filename asset surface.
 *
 * This is issue #9 phase 4: `/assets` and `/files` used to be two
 * implementations of one idea, with a duplicated MIME allowlist, duplicated
 * size caps and a duplicated shared-blob delete guard. They now call the same
 * service, and the only surviving differences are the two the API contract
 * actually promises:
 *
 *   - the path is the bare filename, deduped with `-2` rather than 409'd; and
 *   - the response is shaped `{ asset: … }` for `AssetPanel`.
 *
 * New callers should use `/docs/:id/files`. This stays for the UI panel and
 * for anything written against the pre-#35 surface.
 */

const DocIdParams = z.object({ id: z.string().uuid() });
const AssetParams = z.object({ id: z.string().uuid(), assetId: z.string().uuid() });

export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  app.post('/docs/:id/assets', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);

    const actor = sessionActor(user);
    const file = await uploadFile(serviceContext(app, request, actor), actor, parsed.data.id, {
      read: async () => {
        const upload = await drainUpload(request);
        if (!upload) return null;
        // Flat upload: the asset takes the file's own name.
        return { rawPath: upload.filename, body: upload.body };
      },
      // The behavioural difference that justifies this route still existing.
      dedupePath: true,
    });

    return reply.status(201).send({
      asset: {
        id: file.id,
        filename: file.filename,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        created_at: file.created_at,
      },
    });
  });

  app.get('/docs/:id/assets', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const assets = await listAssets(serviceContext(app, request, actor), actor, parsed.data.id);
    return reply.send({ assets });
  });

  app.delete('/docs/:id/assets/:assetId', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = AssetParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    // expectBlob scopes the lookup to kind='blob' and makes the 404 say
    // "Asset not found", which is what this surface has always returned.
    await deleteFile(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.assetId,
      {
        expectBlob: true,
      },
    );
    return reply.status(204).send();
  });
}
