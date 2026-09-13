import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { getQuotaStatus } from '../../ai/quota.js';
import { serviceContext } from '../../services/context.js';
import { updateSelf } from '../../services/users.js';
import { errorResponses, TokenSummary, UserRecord, UserSummary } from '../schemas.js';
import { actorOf } from '../authenticate.js';

/**
 * Identity: who a token acts as, what it may change about itself, and what
 * budget it is spending.
 *
 * The identity probe was the first route on the plane.
 *
 * Deliberately the one route that shipped with the plane's skeleton: it is the
 * smallest thing that exercises the whole credential path — parse, indexed
 * lookup, constant-time compare, owner resolution, disabled check, scope gate —
 * without depending on any document state.
 *
 * Note the wire format is snake_case, unlike the browser plane's `GET /api/me`,
 * which returns `isAdmin`/`photoUrl`. That shape is load-bearing for
 * `apps/web/src/lib/api.ts` and is left alone; v1 is consistent with the rest of
 * this API instead.
 */
export async function registerV1MeRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.get(
    '/me',
    {
      schema: {
        tags: ['identity'],
        summary: 'Who this token authenticates as',
        description:
          'Returns the user the token acts as — the identity the document ACL is ' +
          'evaluated against — and the scope of the credential used. The cheapest ' +
          'way to check a token works, and to discover its scope without taking a 403.',
        response: {
          200: z
            .object({
              user: UserSummary,
              /** Null would mean a non-token credential; none exists on this plane today. */
              token: TokenSummary.nullable(),
            })
            .meta({ id: 'MeResponse' }),
          ...errorResponses(),
        },
      },
    },
    async (request, reply) => {
      // The auth hook has already refused anything unauthenticated, so an actor
      // is always present here.
      const actor = actorOf(request);
      return reply.send({
        user: {
          id: actor.id,
          email: actor.email,
          name: actor.name,
          is_admin: actor.isAdmin,
        },
        token:
          actor.via.kind === 'token'
            ? { id: actor.via.tokenId, name: actor.via.tokenName, scope: actor.via.scope }
            : null,
      });
    },
  );

  v1.patch(
    '/me',
    {
      schema: {
        tags: ['identity'],
        summary: 'Change your own display name',
        description:
          'The only thing you can change about yourself — an administrator owns ' +
          'and is read-only. A token does this as the user who minted it.',
        body: z.object({ name: z.string().min(1).max(200) }),
        response: { 200: z.object({ user: UserRecord }), ...errorResponses() },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        user: await updateSelf(serviceContext(app, request, actor), actor, request.body),
      });
    },
  );

  v1.get(
    '/ai/quota',
    {
      schema: {
        tags: ['identity'],
        summary: 'Your Claude-assist quota',
        description:
          'Hourly and daily request counts and the daily token allowance, for ' +
          'the user this token acts as. Worth checking before a batch job: the ' +
          "quota is per user, so a token spends its owner's allowance.",
        response: {
          200: z
            .object({
              hourly: z.object({ used: z.number(), limit: z.number() }),
              daily: z.object({ used: z.number(), limit: z.number() }),
              dailyTokens: z.object({ used: z.number(), limit: z.number() }),
            })
            .meta({ id: 'AiQuota' }),
          ...errorResponses(),
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(await getQuotaStatus(app.ctx.db, actor.id));
    },
  );
}
