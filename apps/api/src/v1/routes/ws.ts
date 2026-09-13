import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { serviceContext } from '../../services/context.js';
import { mintWsTicket, TICKET_TTL_MS } from '../../services/ws-tickets.js';
import { errorResponses } from '../schemas.js';
import { actorOf } from '../authenticate.js';

/**
 * The collaboration socket's admission ticket.
 *
 * Included for completeness — a client that wants to co-edit rather than
 * read and write whole files needs one — but it is the one route here that
 * hands out a credential this API cannot then police. Say so on the operation,
 * not only in the ADR.
 */
export async function registerV1WsRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.post(
    '/ws/ticket',
    {
      schema: {
        tags: ['collaboration'],
        summary: 'Mint a ticket for the collaboration WebSocket',
        description:
          'Returns a short-lived, document-bound ticket to pass as `?ticket=…` on ' +
          `the \`wss://\` upgrade URL. Valid for ${TICKET_TTL_MS / 60000} minutes and ` +
          'multi-use within that window; re-mint around reconnects rather than ' +
          'holding one open.\n\n' +
          '**You only need this to speak Yjs.** To read or write a file, use ' +
          '`GET`/`PUT /docs/{id}/files/{fileId}/content` — those are the operations ' +
          'this API is shaped for. The socket is for live co-editing.\n\n' +
          '**What a ticket is not.** Once redeemed it is outside this plane: the ' +
          "socket has no scope gate and no rate limit, and the CRDT's own edits are " +
          'not audited operation by operation. A write-scope token is required to ' +
          'mint one for exactly that reason — a read token must not be able to reach ' +
          'a channel that cannot enforce its scope. Every mint is audited.',
        body: z.object({ doc_id: z.uuid() }).meta({ id: 'WsTicketRequest' }),
        response: {
          201: z
            .object({
              ticket: z.string().describe('Opaque. Store it nowhere; it expires in minutes.'),
              doc_id: z.uuid(),
              expires_at: z.string(),
            })
            .meta({ id: 'WsTicket' }),
          ...errorResponses(),
          403: z
            .object({ error: z.enum(['read_only_token', 'forbidden']), message: z.string() })
            .meta({ id: 'WsTicketForbiddenResponse' }),
          404: z
            .object({ error: z.literal('not_found'), message: z.string() })
            .meta({ id: 'WsTicketNotFoundResponse' })
            .describe('No such document, or none you can read (ADR 0003).'),
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply
        .status(201)
        .send(await mintWsTicket(serviceContext(app, request, actor), actor, request.body.doc_id));
    },
  );
}
