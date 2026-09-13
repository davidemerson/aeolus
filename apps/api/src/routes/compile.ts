import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import {
  enqueueCompile,
  getCompile,
  getSynctex,
  latestCompile,
  latestSynctex,
  openCompiledPdf,
} from '../services/compile.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { notFound } from '../middleware/reply-errors.js';

/**
 * The browser plane's compile routes — thin callers over
 * `services/compile.ts`, which `/api/v1` also uses.
 *
 * The 204-not-404 choices (ADR 0018) live here rather than in the service,
 * because "absent" is a service-level `null` and which status renders it is a
 * transport decision.
 */

const DocIdParams = z.object({ id: z.string().uuid() });
const CompileStatusParams = z.object({
  id: z.string().uuid(),
  jobId: z.string().min(1).max(200),
});

export async function registerCompileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/docs/:id/compile', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const job = await enqueueCompile(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      app.ctx.compileBoss,
    );
    return reply.status(202).send(job);
  });

  // 204 when the document has never compiled successfully: a normal state,
  // and this is fetched on every editor mount (ADR 0018).
  app.get('/docs/:id/compile/latest', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const latest = await latestCompile(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      app.ctx.presignCompiledPdf,
      (err) => request.log.warn({ err }, 'failed to presign compiled pdf'),
    );
    if (!latest) return reply.status(204).send();
    return reply.send(latest);
  });

  app.get('/docs/:id/compile/:jobId', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = CompileStatusParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const view = await getCompile(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.jobId,
      app.ctx.presignCompiledPdf,
      (err) => request.log.warn({ err }, 'failed to presign compiled pdf'),
    );
    return reply.send(view);
  });

  app.get('/docs/:id/synctex/latest', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const bytes = await latestSynctex(serviceContext(app, request, actor), actor, parsed.data.id);
    if (!bytes) return reply.status(204).send();
    return reply
      .header('content-type', 'application/json')
      .header('cache-control', 'private, max-age=300')
      .send(bytes.toString('utf8'));
  });

  app.get('/docs/:id/compile/:jobId/synctex', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = CompileStatusParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const bytes = await getSynctex(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.jobId,
    );
    return reply
      .header('content-type', 'application/json')
      .header('cache-control', 'private, max-age=300')
      .send(bytes.toString('utf8'));
  });

  app.get('/docs/:id/compile/:jobId/download', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = CompileStatusParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const pdf = await openCompiledPdf(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.jobId,
    );

    // Default to attachment: the SPA's PdfPreview renders through PDF.js with
    // its own fetch and ignores Content-Disposition, while the explicit
    // download button wants the browser to save rather than navigate.
    const inline =
      typeof request.query === 'object' &&
      request.query !== null &&
      (request.query as { inline?: string }).inline === '1';

    reply
      .header('content-type', 'application/pdf')
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${pdf.filename}"`,
      )
      .header('cache-control', 'private, max-age=0, must-revalidate');
    if (pdf.contentLength != null) reply.header('content-length', pdf.contentLength);
    return reply.send(pdf.body);
  });
}
