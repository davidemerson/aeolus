import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { resolveUser } from '../auth.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { mintWsTicket } from '../services/ws-tickets.js';
import { sendError } from '../middleware/reply-errors.js';

const TicketBody = z.object({
  doc_id: z.string().uuid(),
});

export async function registerWsTicketRoutes(app: FastifyInstance): Promise<void> {
  // POST /ws/ticket — mints a bearer the SPA passes to ws as ?ticket=… on the
  // upgrade URL. Cookie-gated (same origin as api, no cross-subdomain
  // weirdness). Tickets are multi-use within TICKET_TTL_MS (see consumeTicket
  // in apps/ws/src/server.ts); the SPA re-mints at half-TTL and around
  // reconnects (apps/web/src/lib/ws-ticket.ts) so a long-lived tab never dials
  // with an expired one.
  app.post(
    '/ws/ticket',
    { config: { rateLimit: app.ctx.rateLimits.wsTicket } },
    async (request, reply) => {
      const user = await resolveUser(app, request, reply);
      if (!user) {
        return sendError(reply, 401, 'unauthenticated', 'Not signed in');
      }
      const parsed = TicketBody.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'invalid_body', 'doc_id is required');
      }
      const actor = sessionActor(user);
      const minted = await mintWsTicket(
        serviceContext(app, request, actor),
        actor,
        parsed.data.doc_id,
      );
      return reply.status(201).send(minted);
    },
  );
}
