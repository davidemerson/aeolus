import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';

import { auditEvents } from '@aeolus/db';

import type { Actor } from '../actor.js';
import { AUDIT_RETENTION_DAYS, pruneOldAuditEvents } from '../audit.js';

export { AUDIT_RETENTION_DAYS } from '../audit.js';
import type { ServiceContext } from './context.js';
import { AdminOnlyError } from './errors.js';

/** How long an event is kept. Enforced on read, as ADR 0015 specifies. */

export interface AuditEventView {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: unknown;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditPage {
  events: AuditEventView[];
  next_before: string | null;
  retention_days: number;
}

export async function listAuditEvents(
  ctx: ServiceContext,
  actor: Actor,
  query: { action?: string; actorId?: string; before?: string; limit?: number },
): Promise<AuditPage> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const limit = query.limit ?? 50;
  // The retention sweep runs as a side effect of reading, so retention needs
  // no scheduler. Failure must not break the read.
  await pruneOldAuditEvents(ctx.db).catch((err: unknown) => {
    ctx.log.warn({ err }, 'audit retention sweep failed');
  });

  const filters = [];
  if (query.action) {
    // A trailing dot means prefix — `doc.` matches every document action.
    filters.push(
      query.action.endsWith('.')
        ? sql`${auditEvents.action} LIKE ${query.action + '%'}`
        : eq(auditEvents.action, query.action),
    );
  }
  if (query.actorId) filters.push(eq(auditEvents.actorId, query.actorId));
  if (query.before) filters.push(lt(auditEvents.occurredAt, new Date(query.before)));
  filters.push(
    gte(auditEvents.occurredAt, sql`now() - (${AUDIT_RETENTION_DAYS} * interval '1 day')`),
  );

  // One extra row is the has-more probe, so paging needs no count query.
  const rows = await ctx.db
    .select()
    .from(auditEvents)
    .where(and(...filters))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    events: page.map((r) => ({
      id: r.id,
      occurred_at: r.occurredAt.toISOString(),
      actor_id: r.actorId,
      actor_email: r.actorEmail,
      action: r.action,
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      metadata: r.metadata,
      ip: r.ip,
      user_agent: r.userAgent,
    })),
    // Cursor on occurred_at, so a page boundary cannot skip or repeat a row
    // the way an OFFSET can when new events land mid-read.
    next_before: hasMore ? page[page.length - 1].occurredAt.toISOString() : null,
    retention_days: AUDIT_RETENTION_DAYS,
  };
}
