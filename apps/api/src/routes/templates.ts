import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import { serviceContext, sessionActor } from '../services/context.js';
import {
  createTemplate,
  deleteTemplate,
  forkTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from '../services/templates.js';
import { sendError, notFound } from '../middleware/reply-errors.js';

/**
 * The browser plane's template routes — thin callers over
 * `services/templates.ts`, which `/api/v1` also uses.
 *
 * Admin-gating moved into the service (it is authorization, not transport),
 * so these no longer carry a `requireAdmin` preHandler: a non-admin gets the
 * same `403 forbidden` from the service either way.
 */

const CreateTemplateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  engine: z.enum(['latex', 'typst']),
});

// `is_published` is accepted as well as `isPublished` because the RESPONSE
// serialises snake_case, as does every other wire field in this API. A caller
// that PATCHes back the object it was just handed used to fail validation, and
// the error named the spelling it wanted only if you read it closely — the
// worst kind of miss. Both normalise below; snake_case wins if somehow both
// are sent, since that is the wire spelling.
const PatchTemplateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    isPublished: z.boolean().optional(),
    is_published: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.isPublished !== undefined ||
      v.is_published !== undefined,
    { message: 'at least one field is required' },
  );

const TemplateIdParams = z.object({ id: z.string().uuid() });
const ForkTemplateBody = z.object({ title: z.string().min(1).max(200).optional() }).optional();

export async function registerTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.post('/templates', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const body = CreateTemplateBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', 'name and engine are required');
    }
    const actor = sessionActor(user);
    const template = await createTemplate(serviceContext(app, request, actor), actor, body.data);
    return reply.status(201).send({ template });
  });

  app.get('/templates', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const actor = sessionActor(user);
    const templates = await listTemplates(serviceContext(app, request, actor), actor);
    return reply.send({ templates });
  });

  app.get('/templates/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = TemplateIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const template = await getTemplate(serviceContext(app, request, actor), actor, parsed.data.id);
    return reply.send({ template });
  });

  app.patch('/templates/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = TemplateIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = PatchTemplateBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', 'name, description, or is_published required');
    }
    const actor = sessionActor(user);
    const template = await updateTemplate(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      {
        name: body.data.name,
        description: body.data.description,
        // Collapse the two spellings before anything downstream reads it.
        isPublished: body.data.is_published ?? body.data.isPublished,
      },
    );
    return reply.send({ template });
  });

  app.delete('/templates/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = TemplateIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    await deleteTemplate(serviceContext(app, request, actor), actor, parsed.data.id);
    return reply.status(204).send();
  });

  app.post('/templates/:id/fork', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = TemplateIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = ForkTemplateBody.safeParse(request.body ?? undefined);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', 'title must be 1–200 characters');
    }
    const actor = sessionActor(user);
    const forked = await forkTemplate(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      body.data ?? {},
    );
    return reply.status(201).send(forked);
  });
}
