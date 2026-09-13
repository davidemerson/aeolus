import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { listAuditEvents } from '../../services/audit-events.js';
import { serviceContext } from '../../services/context.js';
import { deleteUser, listUsers, setUserDisabled, updateUser } from '../../services/users.js';
import { errorResponses, UserRecord, UserSummary } from '../schemas.js';
import { actorOf } from '../authenticate.js';

/**
 * Administration: the user roster and the audit log.
 *
 * Both gates apply and they are independent. Scope is checked by the plane's
 * auth hook (a read token cannot POST anything here); the admin check lives in
 * the service, so a write-scope token minted by an ordinary user gets the same
 * `403 forbidden` the browser plane gives them.
 */

const UserIdParams = z.object({ id: z.uuid() });

const notFound = {
  404: z
    .object({ error: z.literal('not_found'), message: z.string() })
    .meta({ id: 'UserNotFoundResponse' }),
} as const;
const forbidden = {
  403: z
    .object({ error: z.string(), message: z.string() })
    .meta({ id: 'AdminForbiddenResponse' })
    .describe('`read_only_token` (scope) or `forbidden` (admin-only operation).'),
} as const;
const selfAction = {
  422: z
    .object({ error: z.enum(['self_delete', 'self_disable']), message: z.string() })
    .meta({ id: 'SelfActionResponse' })
    .describe('You cannot delete or disable your own account.'),
} as const;

export async function registerV1AdminRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.get(
    '/admin/users',
    {
      schema: {
        tags: ['admin'],
        summary: 'List every user',
        description: '**Admin only.** Includes when each was last seen.',
        response: {
          200: z.object({
            users: z.array(
              UserSummary.extend({
                disabled_at: z.string().nullable(),
                last_seen_at: z.string().nullable(),
                created_at: z.string(),
                updated_at: z.string(),
              }).meta({ id: 'AdminUserListEntry' }),
            ),
          }),
          ...errorResponses(),
          ...forbidden,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({ users: await listUsers(serviceContext(app, request, actor), actor) });
    },
  );

  v1.patch(
    '/admin/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Update a user',
        description: '**Admin only.** Grant or revoke admin, or correct a display name.',
        params: UserIdParams,
        body: z
          .object({
            name: z.string().min(1).max(200).optional(),
            is_admin: z.boolean().optional(),
          })
          .refine((b) => b.name !== undefined || b.is_admin !== undefined, {
            message: 'name or is_admin is required',
          }),
        response: {
          200: z.object({ user: UserRecord }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        user: await updateUser(serviceContext(app, request, actor), actor, request.params.id, {
          name: request.body.name,
          isAdmin: request.body.is_admin,
        }),
      });
    },
  );

  for (const disabled of [true, false] as const) {
    const verb = disabled ? 'disable' : 'enable';
    v1.post(
      `/admin/users/:id/${verb}`,
      {
        schema: {
          tags: ['admin'],
          summary: disabled ? 'Disable a user' : 'Re-enable a user',
          description: disabled
            ? '**Admin only.** The reversible alternative to deleting, and it is ' +
              'immediate: a disabled user is refused on every request, which kills ' +
              'their sessions **and every API token they minted** without either ' +
              'having to be enumerated. This is the offboarding lever.'
            : '**Admin only.** Lifts the disable. Tokens they minted work again.',
          params: UserIdParams,
          response: {
            204: z.null(),
            ...errorResponses(),
            ...forbidden,
            ...notFound,
            ...selfAction,
          },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        await setUserDisabled(
          serviceContext(app, request, actor),
          actor,
          (request.params as { id: string }).id,
          disabled,
        );
        return reply.status(204).send(null);
      },
    );
  }

  v1.delete(
    '/admin/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete a user',
        description:
          '**Admin only**, and irreversible. Every document they own is ' +
          'transferred to *you* first, in the same transaction — `docs.owner_id` ' +
          "is RESTRICT precisely so a delete cannot silently take someone's " +
          'drafts with it. Their tokens and sessions go by cascade.\n\n' +
          'Prefer `disable` unless you actually need the row gone.',
        params: UserIdParams,
        response: {
          204: z.null(),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...selfAction,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      await deleteUser(serviceContext(app, request, actor), actor, request.params.id);
      return reply.status(204).send(null);
    },
  );

  v1.get(
    '/admin/audit-events',
    {
      schema: {
        tags: ['admin'],
        summary: 'Read the audit log',
        description:
          '**Admin only.** Newest first, cursor-paginated on `occurred_at` so a ' +
          'page boundary cannot skip or repeat a row the way an OFFSET can while ' +
          'new events land.\n\n' +
          'A trailing dot on `action` makes it a prefix: `doc.` matches every ' +
          'document action. **Events from `/api/v1` carry `metadata.via = ' +
          '"api_token"` and the token id**, so one query answers "what did ' +
          'automation do".\n\n' +
          'Retention is 30 days, enforced as a side effect of reading.',
        querystring: z.object({
          action: z.string().min(1).max(64).optional().describe('Exact, or a `prefix.`'),
          actor_id: z.uuid().optional(),
          before: z.iso.datetime().optional().describe('The `next_before` from a prior page.'),
          limit: z.coerce.number().int().positive().max(200).optional(),
        }),
        response: {
          200: z
            .object({
              events: z.array(
                z
                  .object({
                    id: z.uuid(),
                    occurred_at: z.string(),
                    actor_id: z.uuid().nullable(),
                    actor_email: z
                      .string()
                      .nullable()
                      .describe('Captured at event time, so it survives the account.'),
                    action: z.string(),
                    resource_type: z.string().nullable(),
                    resource_id: z.string().nullable(),
                    metadata: z.any(),
                    ip: z.string().nullable(),
                    user_agent: z.string().nullable(),
                  })
                  .meta({ id: 'AuditEvent' }),
              ),
              next_before: z.string().nullable(),
              retention_days: z.number(),
            })
            .meta({ id: 'AuditPage' }),
          400: z.object({ error: z.string(), message: z.string() }).meta({ id: 'AuditQueryError' }),
          ...errorResponses(),
          ...forbidden,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(
        await listAuditEvents(serviceContext(app, request, actor), actor, {
          action: request.query.action,
          actorId: request.query.actor_id,
          before: request.query.before,
          limit: request.query.limit,
        }),
      );
    },
  );
}
