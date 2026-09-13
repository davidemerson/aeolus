import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { serviceContext } from '../../services/context.js';
import {
  createTemplate,
  deleteTemplate,
  forkTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from '../../services/templates.js';
import { errorResponses } from '../schemas.js';
import { actorOf } from '../authenticate.js';

const Template = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    engine: z.enum(['latex', 'typst']),
    is_published: z
      .boolean()
      .describe('An unpublished template is a draft and is invisible to non-admins.'),
    yjs_doc_id: z.uuid().describe('The backing document. Editable by an admin like any other.'),
    created_by: z.uuid().nullable(),
    deleted_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: 'Template' });

const TemplateIdParams = z.object({ id: z.uuid() });

const notFound = {
  404: z
    .object({ error: z.literal('not_found'), message: z.string() })
    .meta({ id: 'TemplateNotFoundResponse' })
    .describe(
      'No such template — or an unpublished one, to a non-admin. Deliberately ' +
        'indistinguishable, as with documents.',
    ),
} as const;

const forbidden = {
  403: z
    .object({ error: z.string(), message: z.string() })
    .meta({ id: 'TemplateForbiddenResponse' })
    .describe('`read_only_token` (scope) or `forbidden` (admin-only operation).'),
} as const;

export async function registerV1TemplateRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.get(
    '/templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'List templates',
        description: 'Published templates, newest-updated first. Admins also see drafts.',
        response: {
          200: z.object({ templates: z.array(Template) }),
          ...errorResponses(),
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        templates: await listTemplates(serviceContext(app, request, actor), actor),
      });
    },
  );

  v1.get(
    '/templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Get one template',
        params: TemplateIdParams,
        response: {
          200: z.object({ template: Template }),
          ...errorResponses(),
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        template: await getTemplate(serviceContext(app, request, actor), actor, request.params.id),
      });
    },
  );

  v1.post(
    '/templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'Create a template',
        description:
          '**Admin only.** Creates the template and its backing document, which ' +
          'an admin then edits like any other document to fill in the content.',
        body: z.object({
          name: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
          engine: z.enum(['latex', 'typst']),
        }),
        response: {
          201: z.object({ template: Template }),
          ...errorResponses(),
          ...forbidden,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const template = await createTemplate(
        serviceContext(app, request, actor),
        actor,
        request.body,
      );
      return reply.status(201).send({ template });
    },
  );

  v1.patch(
    '/templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Update a template',
        description:
          '**Admin only.** Publishing is `is_published: true` — that is what makes ' +
          'a template visible and forkable by everyone else.',
        params: TemplateIdParams,
        body: z
          .object({
            name: z.string().min(1).max(200).optional(),
            description: z.string().max(2000).nullable().optional(),
            is_published: z.boolean().optional(),
          })
          .refine((v) => Object.keys(v).length > 0, {
            message: 'at least one field is required',
          }),
        response: {
          200: z.object({ template: Template }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        template: await updateTemplate(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          {
            name: request.body.name,
            description: request.body.description,
            isPublished: request.body.is_published,
          },
        ),
      });
    },
  );

  v1.delete(
    '/templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Delete a template',
        description:
          '**Admin only.** Soft delete. The backing document goes with it, or it ' +
          'would linger in admin listings as an orphan nobody can reach. ' +
          'Documents already forked from it are unaffected.',
        params: TemplateIdParams,
        response: { 204: z.null(), ...errorResponses(), ...forbidden, ...notFound },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      await deleteTemplate(serviceContext(app, request, actor), actor, request.params.id);
      return reply.status(204).send(null);
    },
  );

  v1.post(
    '/templates/:id/fork',
    {
      schema: {
        tags: ['templates'],
        summary: 'Fork a template into a new document',
        description:
          'The way a non-admin creates anything. Copies **every** text file — not ' +
          'just the entrypoint — each with its own CRDT, so `\\input` siblings ' +
          'survive. Blobs are copied by reference: a fork is a snapshot of the ' +
          'template at fork time, and the template later deleting a logo does not ' +
          'pull it out from under existing forks.',
        params: TemplateIdParams,
        // `.nullish()`, not `.optional()`: Fastify presents an ABSENT body as
        // `null`, which `.optional()` (undefined only) rejects — so
        // `POST /fork` with no body, the natural way to fork with the default
        // title, answered 400. The browser-plane route coerces with
        // `?? undefined` for the same reason.
        body: z
          .object({
            title: z
              .string()
              .min(1)
              .max(200)
              .optional()
              .describe("Defaults to the template's name."),
          })
          .nullish(),
        response: {
          201: z
            .object({
              doc_id: z.uuid(),
              title: z.string(),
              text_files_copied: z.number(),
              blobs_copied: z.number(),
            })
            .meta({ id: 'ForkResult' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const forked = await forkTemplate(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.body ?? {},
      );
      return reply.status(201).send(forked);
    },
  );
}
