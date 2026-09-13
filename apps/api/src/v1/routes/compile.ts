import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  buildProjectZip,
  enqueueCompile,
  getCompile,
  getSynctex,
  latestCompile,
  latestSynctex,
  openCompiledPdf,
} from '../../services/compile.js';
import { serviceContext } from '../../services/context.js';
import { errorResponses } from '../schemas.js';
import { actorOf } from '../authenticate.js';

const DocIdParams = z.object({ id: z.uuid() });
const JobParams = z.object({ id: z.uuid(), jobId: z.string().min(1).max(200) });

const notFound = {
  404: z
    .object({ error: z.literal('not_found'), message: z.string() })
    .meta({ id: 'CompileNotFoundResponse' }),
} as const;
const forbidden = {
  403: z
    .object({ error: z.string(), message: z.string() })
    .meta({ id: 'CompileForbiddenResponse' }),
} as const;

const Compile = z
  .object({
    job_id: z.string(),
    doc_id: z.uuid(),
    engine: z.string(),
    status: z
      .enum(['queued', 'running', 'success', 'failed'])
      .describe('Poll until it leaves queued/running.'),
    rev: z.string(),
    pdf_key: z.string().nullable(),
    pdf_url: z.string().nullable().describe('Relative to /api. Null unless the compile succeeded.'),
    synctex_url: z.string().nullable(),
    error: z.string().nullable().describe('The engine log excerpt, on failure.'),
    warnings: z
      .array(z.string())
      .describe(
        'Non-fatal findings on a successful compile — e.g. a font the PDF references but does not embed, which renders blank on machines without it. Empty when clean. Do not ship a PDF that carries one without reading it.',
      ),
    started_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .meta({ id: 'Compile' });

export async function registerV1CompileRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.post(
    '/docs/:id/compile',
    {
      // A compile is a container-minute of Tectonic or Typst, so this gets a
      // much tighter budget than the plane default of 120/min.
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        tags: ['compile'],
        summary: 'Start a compile',
        description:
          'Enqueues a job and returns immediately with `202`. Poll ' +
          '`GET /docs/{id}/compile/{jobId}` until `status` leaves ' +
          '`queued`/`running`, then fetch the PDF from `/download`.\n\n' +
          'Rate limited to **6 per minute per token** — each one is a ' +
          'container-minute of Tectonic or Typst.',
        params: DocIdParams,
        response: {
          202: z
            .object({
              job_id: z.string(),
              doc_id: z.uuid(),
              engine: z.enum(['latex', 'typst']),
              rev: z.string(),
              status: z.literal('queued'),
            })
            .meta({ id: 'EnqueuedCompile' }),
          409: z
            .object({ error: z.literal('unsupported_engine'), message: z.string() })
            .meta({ id: 'UnsupportedEngineResponse' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const job = await enqueueCompile(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        app.ctx.compileBoss,
      );
      return reply.status(202).send(job);
    },
  );

  v1.get(
    '/docs/:id/compile/latest',
    {
      schema: {
        tags: ['compile'],
        summary: 'The newest successful compile',
        description:
          '**204 when the document has never compiled successfully** — a normal ' +
          'state, not an error (ADR 0018).\n\n' +
          '`is_current` tells you whether this PDF still matches the project, so ' +
          'you can skip a rebuild. It is not a revision comparison: editing a ' +
          'sibling file or adding an image does not move `rev`, so the server ' +
          'compares timestamps across the whole project and errs toward `false`.',
        params: DocIdParams,
        response: {
          200: z
            .object({
              job_id: z.string(),
              doc_id: z.uuid(),
              engine: z.string(),
              rev: z.string(),
              pdf_url: z.string(),
              finished_at: z.string().nullable(),
              is_current: z.boolean(),
              warnings: z
                .array(z.string())
                .describe('The warnings recorded on that compile — see Compile.warnings.'),
            })
            .meta({ id: 'LatestCompile' }),
          204: z.null(),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const latest = await latestCompile(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        app.ctx.presignCompiledPdf,
        (err) => request.log.warn({ err }, 'failed to presign compiled pdf'),
      );
      if (!latest) return reply.status(204).send(null);
      return reply.send(latest);
    },
  );

  v1.get(
    '/docs/:id/compile/:jobId',
    {
      schema: {
        tags: ['compile'],
        summary: 'Compile status',
        description:
          'Poll this after starting a compile. On failure, `error` carries the ' +
          'engine log excerpt — which is what you want in CI output.',
        params: JobParams,
        response: { 200: Compile, ...errorResponses(), ...forbidden, ...notFound },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(
        await getCompile(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.params.jobId,
          app.ctx.presignCompiledPdf,
          (err) => request.log.warn({ err }, 'failed to presign compiled pdf'),
        ),
      );
    },
  );

  v1.get(
    '/docs/:id/compile/:jobId/download',
    {
      schema: {
        tags: ['compile'],
        summary: 'Download the compiled PDF',
        description:
          'Streams `application/pdf`. This is the only way to the bytes — there ' +
          'is no public or presigned URL. `?inline=1` flips Content-Disposition.',
        params: JobParams,
        querystring: z.object({ inline: z.enum(['0', '1']).optional() }),
        response: {
          200: z.any().describe('The PDF bytes.'),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const pdf = await openCompiledPdf(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.params.jobId,
      );
      reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `${request.query.inline === '1' ? 'inline' : 'attachment'}; filename="${pdf.filename}"`,
        )
        .header('cache-control', 'private, max-age=0, must-revalidate');
      if (pdf.contentLength != null) reply.header('content-length', pdf.contentLength);
      return reply.send(pdf.body);
    },
  );

  v1.get(
    '/docs/:id/synctex/latest',
    {
      schema: {
        tags: ['compile'],
        summary: 'The newest synctex map',
        description:
          'The source↔PDF position map from the most recent successful LaTeX ' +
          'compile. **204** when there is none — never compiled, a Typst ' +
          'document (Typst emits no synctex, permanently), or the blob has gone. ' +
          'None of those is an error the caller can act on differently.',
        params: DocIdParams,
        response: {
          200: z.any().describe('The synctex JSON.'),
          204: z.null(),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const bytes = await latestSynctex(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
      );
      if (!bytes) return reply.status(204).send(null);
      return reply
        .header('content-type', 'application/json')
        .header('cache-control', 'private, max-age=300')
        .send(bytes.toString('utf8'));
    },
  );

  v1.get(
    '/docs/:id/compile/:jobId/synctex',
    {
      schema: {
        tags: ['compile'],
        summary: "One compile's synctex map",
        description:
          'Unlike `/synctex/latest`, an absent map here is a **404** — you named ' +
          'a specific job, so "it has none" is an answer about that job.',
        params: JobParams,
        response: {
          200: z.any().describe('The synctex JSON.'),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const bytes = await getSynctex(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.params.jobId,
      );
      return reply
        .header('content-type', 'application/json')
        .header('cache-control', 'private, max-age=300')
        .send(bytes.toString('utf8'));
    },
  );

  v1.get(
    '/docs/:id/download.zip',
    {
      // Loads every text CRDT and every blob into memory to build the archive.
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        tags: ['compile'],
        summary: 'Download the whole project as a zip',
        description:
          'Every file: text rendered from its CRDT to UTF-8, blobs verbatim. ' +
          'The way to get a project out of Aeolus.\n\n' +
          'Rate limited to **6 per minute per token** — it loads the whole ' +
          'project into memory.',
        params: DocIdParams,
        response: {
          200: z.any().describe('The zip archive.'),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const archive = await buildProjectZip(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        (info) =>
          request.log.warn(
            { ...info, docId: request.params.id },
            'project-zip: blob missing for doc_files row',
          ),
      );
      return reply
        .header('content-type', 'application/zip')
        .header('content-length', archive.bytes.length)
        .header('content-disposition', `attachment; filename="${archive.filename}"`)
        .send(archive.bytes);
    },
  );
}
