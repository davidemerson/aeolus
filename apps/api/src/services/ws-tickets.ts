import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { wsTickets } from '@aeolus/db';

import { assertCanRead } from '../acl.js';
import type { Actor } from '../actor.js';
import type { ServiceContext } from './context.js';

/**
 * Tickets for the Yjs collaboration socket, for both planes.
 *
 * Ticket TTL: 5 minutes. Long enough that ordinary network blips, tab-sleep
 * wakeups, and y-websocket's exponential reconnect delays fit comfortably
 * inside a single ticket window without needing a re-mint. Short enough that a
 * ticket leaked in transit (HTTPS-protected, ZT-only) has minimal exposure.
 * Tickets are renewable within the window — see `consumeTicket` in
 * `apps/ws/src/server.ts`.
 */
export const TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_BYTES = 32;

export function hashTicket(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface MintedTicket {
  ticket: string;
  doc_id: string;
  expires_at: string;
}

/**
 * Mint a ticket admitting the actor to one document's collaboration room.
 *
 * The ticket is bound to a document, so a stolen one opens only what it was
 * issued for — but it is otherwise the least constrained credential this API
 * hands out. The WebSocket has no scope gate and no rate limit; a reader who
 * can `assertCanRead` gets a ticket, and the room's own ACL is what stops them
 * writing. That is why the mint is audited even though the browser plane never
 * needed it to be: on `/api/v1` it is the one call whose consequences the API
 * cannot see afterwards.
 */
export async function mintWsTicket(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
): Promise<MintedTicket> {
  await assertCanRead(ctx.acl, actor.id, docId);

  const ticket = randomBytes(TICKET_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await ctx.db.insert(wsTickets).values({
    ticketHash: hashTicket(ticket),
    userId: actor.id,
    docId,
    expiresAt,
  });

  // Best-effort cleanup of expired rows so the table doesn't grow unbounded.
  // Cheap because expires_at is indexed.
  await ctx.db
    .delete(wsTickets)
    .where(sql`${wsTickets.expiresAt} < now() - interval '1 hour'`)
    .catch(() => undefined);

  await ctx.audit({
    action: 'ws.ticket.mint',
    resourceType: 'doc',
    resourceId: docId,
    metadata: { expires_at: expiresAt.toISOString() },
  });

  return { ticket, doc_id: docId, expires_at: expiresAt.toISOString() };
}
