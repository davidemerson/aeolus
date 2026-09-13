import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireUser } from '../middleware/require-user.js';
import { serviceContext, sessionActor } from '../services/context.js';
import {
  addCollaborator,
  createDoc,
  deleteDoc,
  getDoc,
  listDocs,
  removeCollaborator,
  setArchived,
  updateDoc,
} from '../services/docs.js';
import { sendError, notFound } from '../middleware/reply-errors.js';

/**
 * The browser plane's document routes.
 *
 * These are thin callers over `services/docs.ts`, which `/api/v1` also uses —
 * so the two planes cannot drift, because there is one implementation. What
 * stays here is only what is genuinely HTTP: parsing the request, and choosing
 * a status code for success.
 *
 * Errors are NOT mapped here. The service throws `DocNotFoundError` /
 * `DocForbiddenError` / `DocArchivedError`, which carry `statusCode` and
 * `code`, and the global `setErrorHandler` in server.ts renders them into the
 * same `{ error, message }` this file used to build by hand.
 */

const CreateDocBody = z.object({
  title: z.string().min(1).max(200),
  engine: z.enum(['latex', 'typst']),
});
const PatchDocBody = z.object({ title: z.string().min(1).max(200) });
const AddCollaboratorBody = z.object({
  email: z.string().email(),
  role: z.enum(['editor', 'viewer']),
});
const DocIdParams = z.object({ id: z.string().uuid() });
const CollaboratorParams = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});
const ListQuery = z.object({
  includeDeleted: z.enum(['true', 'false']).optional(),
  // Workspace tabs: default `active` hides archived docs from the primary
  // list; `archived` returns only archived; `all` returns both. Soft-deleted
  // is independent and still hidden unless includeDeleted is set.
  status: z.enum(['active', 'archived', 'all']).optional(),
});

// A malformed id is 404 rather than 400: a caller who cannot name a real
// document must not learn the difference between "not a uuid" and "not yours"
// (ADR 0003).

export async function registerDocRoutes(app: FastifyInstance): Promise<void> {
  app.post('/docs', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const body = CreateDocBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', 'title and engine are required');
    }
    const actor = sessionActor(user);
    const created = await createDoc(serviceContext(app, request, actor), actor, body.data);
    return reply.status(201).send(created);
  });

  app.get('/docs', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const query = ListQuery.safeParse(request.query ?? {});
    const actor = sessionActor(user);
    const docs = await listDocs(serviceContext(app, request, actor), actor, {
      status: query.success ? query.data.status : undefined,
      includeDeleted: query.success && query.data.includeDeleted === 'true',
    });
    return reply.send({ docs });
  });

  app.get('/docs/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const doc = await getDoc(serviceContext(app, request, actor), actor, parsed.data.id);
    return reply.send({ doc });
  });

  app.patch('/docs/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = PatchDocBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'invalid_body', 'title is required');
    const actor = sessionActor(user);
    const doc = await updateDoc(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      body.data,
    );
    return reply.send({ doc });
  });

  app.delete('/docs/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    await deleteDoc(serviceContext(app, request, actor), actor, parsed.data.id);
    return reply.status(204).send();
  });

  app.post('/docs/:id/archive', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const doc = await setArchived(serviceContext(app, request, actor), actor, parsed.data.id, true);
    return reply.send({ doc });
  });

  app.post('/docs/:id/unarchive', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    const doc = await setArchived(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      false,
    );
    return reply.send({ doc });
  });

  app.post('/docs/:id/collaborators', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = DocIdParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const body = AddCollaboratorBody.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', 'email and role are required');
    }
    const actor = sessionActor(user);
    const added = await addCollaborator(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      body.data,
    );
    return reply.status(201).send(added);
  });

  app.delete('/docs/:id/collaborators/:userId', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    const parsed = CollaboratorParams.safeParse(request.params);
    if (!parsed.success) return notFound(reply);
    const actor = sessionActor(user);
    await removeCollaborator(
      serviceContext(app, request, actor),
      actor,
      parsed.data.id,
      parsed.data.userId,
    );
    return reply.status(204).send();
  });
}
