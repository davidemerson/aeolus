import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { auditEvents, type Database } from '@aeolus/db';

// Audit log helper. emitAudit(...) writes a row capturing what
// happened, who did it, and a small bag of metadata. See ADR 0015.
//
// Design constraints:
//   - Never blocks the user-facing response on its own failure.
//     Insert errors are logged and swallowed; the original user
//     action still succeeds. (A failure to record the audit is bad
//     but not worth aborting a doc save over.)
//   - Captures the actor's email at event time so the log survives
//     later user deletion. The FK to users.id is set-null on
//     delete; the email column is the durable identifier.
//   - 30-day retention is enforced by sweeping rows older than that
//     on every read of the list endpoint. Cheap (the index covers
//     occurred_at), no scheduler required.

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.passphrase_set'
  | 'auth.passphrase_reset'
  | 'user.create'
  | 'user.update'
  | 'user.disable'
  | 'user.enable'
  | 'user.delete'
  | 'doc.create'
  | 'doc.update'
  | 'doc.delete'
  | 'doc.archive'
  | 'doc.unarchive'
  | 'doc.open'
  | 'doc.collaborator.add'
  | 'doc.collaborator.remove'
  | 'template.create'
  | 'template.update'
  | 'template.delete'
  | 'template.fork'
  | 'admin.blob_gc'
  // Minting and revoking a /api/v1 bearer credential. Both are recorded
  // because a token acts as its minting user, so its existence is an
  // authorization fact, not a preference.
  | 'token.mint'
  | 'token.revoke'
  // File-tree mutations. These had NO audit coverage at all, which mattered
  // less when every caller was a human in the editor and matters more now a
  // long-lived machine credential can reach them.
  | 'file.create'
  | 'file.upload'
  | 'file.rename'
  | 'file.write'
  | 'file.delete'
  // Version history. Auto-open checkpoints are deliberately NOT audited: they
  // fire on every editor mount, and burying real events under that noise
  // would make the trail useless.
  | 'checkpoint.create'
  | 'checkpoint.restore'
  | 'project_checkpoint.create'
  | 'project_checkpoint.restore'
  | 'project_checkpoint.delete'
  // Claude-assist and the collaboration-socket ticket. `ai_requests` already
  // ledgers what an assist cost; this answers who asked, and — for a call over
  // /api/v1 — that a machine did. A ws ticket is audited because it is the one
  // credential this API hands out that the API cannot then police: it is
  // redeemed on the WebSocket, where there is no scope and no rate limit.
  | 'ai.assist'
  | 'ws.ticket.mint';

export interface EmitAuditInput {
  action: AuditAction;
  actorId?: string | null;
  actorEmail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export async function emitAudit(db: Database, input: EmitAuditInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      action: input.action,
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (err) {
    // Audit failure should never bubble up to the caller. Surface
    // it to stderr so an operator scanning logs can find it; in
    // practice this only fires if the table doesn't exist (broken
    // deploy) or the row violates a constraint (unlikely).
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        source: 'audit',
        msg: 'failed to record audit event',
        action: input.action,
        err: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

// Convenience: pull common request-scoped fields (ip, user-agent)
// off a Fastify request. Lets route handlers call
// `emitAudit(db, { action, ...auditFromRequest(request), actorId,
// resourceType, resourceId })` without repeating boilerplate.
export function auditFromRequest(request: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  // Prefer the X-Forwarded-For first hop when behind the ALB; fall
  // back to the socket address for direct connections (tests, dev).
  const xff = request.headers['x-forwarded-for'];
  let ip: string | null = null;
  if (typeof xff === 'string' && xff.length > 0) {
    ip = xff.split(',')[0].trim();
  } else if (Array.isArray(xff) && xff.length > 0) {
    ip = xff[0].split(',')[0].trim();
  } else if (request.ip) {
    ip = request.ip;
  }
  const ua = request.headers['user-agent'];
  return {
    ip,
    userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null,
  };
}

// Sweep audit rows older than 30 days. Cheap because of
// audit_events_occurred_at_idx. Called from the admin list endpoint
// before serving each page, so retention is enforced as a side
// effect of the most common admin action; no separate scheduler.
/** How long audit rows live. The sweep runs as a side effect of reading (services/audit-events.ts). */
export const AUDIT_RETENTION_DAYS = 30;

export async function pruneOldAuditEvents(
  db: Database,
  retentionDays = AUDIT_RETENTION_DAYS,
): Promise<number> {
  const result = await db
    .delete(auditEvents)
    .where(sql`${auditEvents.occurredAt} < now() - (${retentionDays} || ' days')::interval`);
  return (result as { rowCount?: number }).rowCount ?? 0;
}
