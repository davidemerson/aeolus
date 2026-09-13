import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { BlobStore } from '@aeolus/crdt';
import type { Database } from '@aeolus/db';

import type { Actor } from '../actor.js';
import { createDbAclDeps, type AclDeps } from '../acl.js';
import { auditFromRequest, emitAudit, type AuditAction } from '../audit.js';

/**
 * Just enough of a logger for work a service does after the response is
 * already gone. Structural on purpose — pino satisfies it, and importing
 * `FastifyBaseLogger` here would breach the rule below.
 */
export interface ServiceLogger {
  error(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Everything a service needs from the request it is serving, with nothing
 * Fastify-shaped in it.
 *
 * The rule the service layer keeps: **no Fastify types below this line.** A
 * service takes `(ctx, actor, input)`, returns data, and throws a typed error.
 * It never sees a `reply`, never chooses a status code, and never serialises.
 * That is what lets the browser plane and `/api/v1` share one implementation
 * instead of two that must be kept in agreement.
 */
export interface ServiceContext {
  db: Database;
  blobs: BlobStore;
  acl: AclDeps;
  /** For failures that cannot reach the client, e.g. a post-stream ledger write. */
  log: ServiceLogger;
  /**
   * Emit an audit event. Pre-bound with the request's IP, user-agent and
   * actor, so a call site names only what happened — and so a token-driven
   * change is automatically attributed as one, without every service
   * remembering to do it.
   */
  audit(input: {
    action: AuditAction;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export function serviceContext(
  app: FastifyInstance,
  request: FastifyRequest,
  actor: Actor,
): ServiceContext {
  const base = auditFromRequest(request);
  return {
    db: app.ctx.db,
    blobs: app.ctx.blobs,
    acl: createDbAclDeps(app.ctx.db),
    log: request.log,
    async audit(input) {
      await emitAudit(app.ctx.db, {
        ...base,
        actorId: actor.id,
        actorEmail: actor.email,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: {
          ...(input.metadata ?? {}),
          // Which plane did this. One audit query then answers "what did
          // automation do", without a second action vocabulary.
          ...(actor.via.kind === 'token' ? { via: 'api_token', token_id: actor.via.tokenId } : {}),
        },
      });
    },
  };
}

/** A session-authenticated caller, as an Actor. */
export function sessionActor(user: {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
}): Actor {
  return { ...user, via: { kind: 'session' } };
}
