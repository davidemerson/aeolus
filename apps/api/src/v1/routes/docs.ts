import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { serviceContext } from '../../services/context.js';
import {
  addCollaborator,
  createDoc,
  deleteDoc,
  getDoc,
  listCollaborators,
  listDocs,
  removeCollaborator,
  setArchived,
  updateDoc,
} from '../../services/docs.js';
import { errorResponses } from '../schemas.js';
import { actorOf } from '../authenticate.js';

const Doc = z
  .object({
    id: z.uuid(),
    title: z.string(),
    engine: z.enum(['latex', 'typst']),
    owner_id: z.uuid(),
    deleted_at: z.string().nullable(),
    archived_at: z
      .string()
      .nullable()
      .describe('When set, the document is read-only: writes return 422 `archived`.'),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: 'Doc' });

const Collaborator = z
  .object({
    id: z.uuid(),
    user_id: z.uuid(),
    email: z.string().nullable(),
    role: z.enum(['viewer', 'editor']),
  })
  .meta({ id: 'Collaborator' });

const DocIdParams = z.object({ id: z.uuid() });

/** Reused by every route that addresses one document. */
const docNotFound = {
  404: z
    .object({ error: z.literal('not_found'), message: z.string() })
    .meta({ id: 'DocNotFoundResponse' })
    .describe(
      "No such document — OR one this token's user cannot read. The two are " +
        'deliberately indistinguishable, so the API never confirms a document ' +
        'exists to someone without access.',
    ),
} as const;

const docForbidden = {
  403: z
    .object({ error: z.string(), message: z.string() })
    .meta({ id: 'DocForbiddenResponse' })
    .describe(
      'Either the token is read-scope (`read_only_token`), or its user lacks ' +
        'permission on this document (`forbidden`). Branch on `error`.',
    ),
} as const;

const docArchived = {
  422: z
    .object({ error: z.literal('archived'), message: z.string() })
    .meta({ id: 'DocArchivedResponse' })
    .describe('The document is archived and therefore read-only. Unarchive it first.'),
} as const;

export async function registerV1DocRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.get(
    '/docs',
    {
      schema: {
        tags: ['documents'],
        summary: 'List documents',
        description:
          "Documents the token's user owns or collaborates on, newest-updated " +
          'first. Admins see every non-template document. Template-backing ' +
          'documents never appear.',
        querystring: z.object({
          status: z
            .enum(['active', 'archived', 'all'])
            .optional()
            .describe('Defaults to `active`, which hides archived documents.'),
          include_deleted: z
            .stringbool()
            .optional()
            .describe('Admin-only; ignored for everyone else. Soft-deleted documents.'),
        }),
        response: { 200: z.object({ docs: z.array(Doc) }), ...errorResponses() },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        docs: await listDocs(serviceContext(app, request, actor), actor, {
          status: request.query.status,
          includeDeleted: request.query.include_deleted,
        }),
      });
    },
  );

  v1.post(
    '/docs',
    {
      schema: {
        tags: ['documents'],
        summary: 'Create a blank document',
        description:
          '**Admin only.** Everyone else creates documents by forking a curated ' +
          'template, which is the brand-controlled path. A non-admin token gets ' +
          '403 `forbidden` here however wide its scope.',
        body: z.object({
          title: z.string().min(1).max(200),
          engine: z.enum(['latex', 'typst']),
        }),
        response: {
          201: z.object({ id: z.uuid() }),
          ...errorResponses(),
          ...docForbidden,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const created = await createDoc(serviceContext(app, request, actor), actor, request.body);
      return reply.status(201).send(created);
    },
  );

  v1.get(
    '/docs/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Get one document',
        params: DocIdParams,
        response: { 200: z.object({ doc: Doc }), ...errorResponses(), ...docNotFound },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        doc: await getDoc(serviceContext(app, request, actor), actor, request.params.id),
      });
    },
  );

  v1.patch(
    '/docs/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Rename a document',
        params: DocIdParams,
        body: z.object({ title: z.string().min(1).max(200) }),
        response: {
          200: z.object({ doc: Doc }),
          ...errorResponses(),
          ...docForbidden,
          ...docNotFound,
          ...docArchived,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        doc: await updateDoc(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.body,
        ),
      });
    },
  );

  v1.delete(
    '/docs/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Delete a document',
        description:
          'A soft delete: the row is retained and an admin can still see it with ' +
          '`include_deleted`. Owner or admin only — an editor gets 403.',
        params: DocIdParams,
        response: {
          204: z.null(),
          ...errorResponses(),
          ...docForbidden,
          ...docNotFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      await deleteDoc(serviceContext(app, request, actor), actor, request.params.id);
      return reply.status(204).send(null);
    },
  );

  for (const archived of [true, false] as const) {
    const verb = archived ? 'archive' : 'unarchive';
    v1.post(
      `/docs/:id/${verb}`,
      {
        schema: {
          tags: ['documents'],
          summary: archived ? 'Archive a document' : 'Unarchive a document',
          description: archived
            ? 'Marks the document read-only. Idempotent. Owner or admin only — ' +
              'an editor cannot archive, and the archive lock does not gate its ' +
              'own toggle.'
            : 'Lifts the read-only lock. Idempotent.',
          params: DocIdParams,
          response: {
            200: z.object({ doc: Doc }),
            ...errorResponses(),
            ...docForbidden,
            ...docNotFound,
          },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        return reply.send({
          doc: await setArchived(
            serviceContext(app, request, actor),
            actor,
            (request.params as { id: string }).id,
            archived,
          ),
        });
      },
    );
  }

  v1.get(
    '/docs/:id/collaborators',
    {
      schema: {
        tags: ['documents'],
        summary: "List a document's collaborators",
        description:
          'Readable by anyone who can read the document. The owner is not listed ' +
          'here — they are `doc.owner_id`.',
        params: DocIdParams,
        response: {
          200: z.object({ collaborators: z.array(Collaborator) }),
          ...errorResponses(),
          ...docNotFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        collaborators: await listCollaborators(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
        ),
      });
    },
  );

  v1.post(
    '/docs/:id/collaborators',
    {
      schema: {
        tags: ['documents'],
        summary: 'Add a collaborator',
        description:
          'Owner or admin only. The target must have signed in at least once — ' +
          'Aeolus has no invite flow, so there is no user row to grant against ' +
          'until they do.',
        params: DocIdParams,
        body: z.object({
          email: z.email(),
          role: z.enum(['editor', 'viewer']),
        }),
        response: {
          201: z.object({ id: z.uuid(), user_id: z.uuid(), role: z.enum(['editor', 'viewer']) }),
          409: z
            .object({
              error: z.enum(['user_not_found', 'already_collaborator']),
              message: z.string(),
            })
            .meta({ id: 'AddCollaboratorConflict' }),
          ...errorResponses(),
          ...docForbidden,
          ...docNotFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const added = await addCollaborator(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.body,
      );
      return reply.status(201).send(added);
    },
  );

  v1.delete(
    '/docs/:id/collaborators/:userId',
    {
      schema: {
        tags: ['documents'],
        summary: 'Remove a collaborator',
        params: z.object({ id: z.uuid(), userId: z.uuid() }),
        response: {
          204: z.null(),
          ...errorResponses(),
          ...docForbidden,
          ...docNotFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      await removeCollaborator(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.params.userId,
      );
      return reply.status(204).send(null);
    },
  );
}
