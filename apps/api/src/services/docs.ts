import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import { docCollaborators, docFiles, docs, users } from '@aeolus/db';

import type { Actor } from '../actor.js';
import { assertCanAdminister, assertCanRead, assertCanWrite, DocNotFoundError } from '../acl.js';
import type { ServiceContext } from './context.js';
import { AdminOnlyError } from './errors.js';

/**
 * Document operations, shared by the browser plane and `/api/v1`.
 *
 * Errors are THROWN, not mapped: `DocNotFoundError`, `DocForbiddenError` and
 * `DocArchivedError` already carry `statusCode` and `code`, and both planes'
 * error handlers read those — so `throw new DocNotFoundError()` produces
 * byte-identical output to the hand-written `notFound(reply)` these routes
 * used to call, with none of the duplication.
 */

export interface DocView {
  id: string;
  title: string;
  engine: DocEngine;
  owner_id: string;
  deleted_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocRow {
  id: string;
  title: string;
  engine: string;
  ownerId: string;
  deletedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const docColumns = {
  id: docs.id,
  title: docs.title,
  engine: docs.engine,
  ownerId: docs.ownerId,
  deletedAt: docs.deletedAt,
  archivedAt: docs.archivedAt,
  createdAt: docs.createdAt,
  updatedAt: docs.updatedAt,
};

export function toDocView(row: DocRow): DocView {
  return {
    id: row.id,
    title: row.title,
    engine: asEngine(row.engine),
    owner_id: row.ownerId,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
    archived_at: row.archivedAt ? row.archivedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export class UserNotFoundError extends Error {
  readonly statusCode = 409;
  readonly code = 'user_not_found';
  constructor() {
    super('No user with that email. They must sign in once before they can be added.');
  }
}

export class AlreadyCollaboratorError extends Error {
  readonly statusCode = 409;
  readonly code = 'already_collaborator';
  constructor() {
    super('User is already a collaborator on this document');
  }
}

export class CollaboratorNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
  constructor() {
    super('Collaborator not found');
  }
}

export { AdminOnlyError };

export type DocStatusFilter = 'active' | 'archived' | 'all';

/** `docs.engine` is CHECK-constrained to these two in the schema. */
export type DocEngine = 'latex' | 'typst';
function asEngine(v: string): DocEngine {
  return v === 'typst' ? 'typst' : 'latex';
}

/** `doc_collaborators.role` is CHECK-constrained to these two in the schema. */
export type CollaboratorRole = 'editor' | 'viewer';
function asRole(v: string): CollaboratorRole {
  return v === 'editor' ? 'editor' : 'viewer';
}

export async function listDocs(
  ctx: ServiceContext,
  actor: Actor,
  opts: { status?: DocStatusFilter; includeDeleted?: boolean } = {},
): Promise<DocView[]> {
  const status = opts.status ?? 'active';
  const archiveFilter =
    status === 'active'
      ? isNull(docs.archivedAt)
      : status === 'archived'
        ? isNotNull(docs.archivedAt)
        : null;

  if (actor.isAdmin) {
    const conditions = [eq(docs.isTemplateDoc, false)];
    // includeDeleted is admin-only by construction: this is the only branch
    // that honours it.
    if (!opts.includeDeleted) conditions.push(isNull(docs.deletedAt));
    if (archiveFilter) conditions.push(archiveFilter);
    const rows = await ctx.db
      .select(docColumns)
      .from(docs)
      .where(and(...conditions))
      .orderBy(desc(docs.updatedAt));
    return rows.map(toDocView);
  }

  const base = [isNull(docs.deletedAt), eq(docs.isTemplateDoc, false)];
  if (archiveFilter) base.push(archiveFilter);

  const owned: DocRow[] = await ctx.db
    .select(docColumns)
    .from(docs)
    .where(and(eq(docs.ownerId, actor.id), ...base))
    .orderBy(desc(docs.updatedAt));

  const shared: DocRow[] = await ctx.db
    .select(docColumns)
    .from(docs)
    .innerJoin(docCollaborators, eq(docCollaborators.docId, docs.id))
    .where(and(eq(docCollaborators.userId, actor.id), ...base))
    .orderBy(desc(docs.updatedAt));

  // Owned and shared can overlap (an owner who is also listed as a
  // collaborator); dedupe keeping the owned ordering.
  const seen = new Set<string>();
  const merged: DocRow[] = [];
  for (const row of [...owned, ...shared]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged.map(toDocView);
}

export async function getDoc(ctx: ServiceContext, actor: Actor, docId: string): Promise<DocView> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const [row] = await ctx.db.select(docColumns).from(docs).where(eq(docs.id, docId)).limit(1);
  if (!row) throw new DocNotFoundError();
  await ctx.audit({ action: 'doc.open', resourceType: 'doc', resourceId: row.id });
  return toDocView(row);
}

/**
 * Admin-only, deliberately. End users always start from an admin-curated
 * template — the fork route is their path — per the brand-controlled mandate.
 */
export async function createDoc(
  ctx: ServiceContext,
  actor: Actor,
  input: { title: string; engine: DocEngine },
): Promise<{ id: string }> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const row = await ctx.db.transaction(async (tx) => {
    const [d] = await tx
      .insert(docs)
      .values({ title: input.title, engine: input.engine, ownerId: actor.id })
      .returning({ id: docs.id });
    // The doc_files row is the issue-#9 dual-write: it keeps doc_files in
    // lockstep with every new doc so the worker needs no backfill window.
    await tx.insert(docFiles).values({
      docId: d.id,
      path: input.engine === 'typst' ? 'main.typ' : 'main.tex',
      kind: 'text',
      // yjsDocId = docs.id mirrors the per-doc Yjs key for the entrypoint.
      yjsDocId: d.id,
    });
    return d;
  });

  await ctx.audit({
    action: 'doc.create',
    resourceType: 'doc',
    resourceId: row.id,
    metadata: { title: input.title, engine: input.engine },
  });
  return { id: row.id };
}

export async function updateDoc(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  input: { title: string },
): Promise<DocView> {
  await assertCanWrite(ctx.acl, actor.id, docId);
  const [updated] = await ctx.db
    .update(docs)
    .set({ title: input.title, updatedAt: new Date() })
    .where(eq(docs.id, docId))
    .returning(docColumns);
  if (!updated) throw new DocNotFoundError();
  await ctx.audit({
    action: 'doc.update',
    resourceType: 'doc',
    resourceId: updated.id,
    metadata: { title: input.title },
  });
  return toDocView(updated);
}

export async function deleteDoc(ctx: ServiceContext, actor: Actor, docId: string): Promise<void> {
  await assertCanAdminister(ctx.acl, actor.id, docId);
  await ctx.db
    .update(docs)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(docs.id, docId));
  await ctx.audit({ action: 'doc.delete', resourceType: 'doc', resourceId: docId });
}

/**
 * Archive and unarchive both go through `assertCanAdminister`, not
 * `assertCanWrite` — an editor must not toggle it, and the unarchive path has
 * to be able to lift the very lock `assertCanWrite` enforces. Idempotent: the
 * second call returns the same row.
 */
export async function setArchived(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  archived: boolean,
): Promise<DocView> {
  await assertCanAdminister(ctx.acl, actor.id, docId);
  const [updated] = await ctx.db
    .update(docs)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(docs.id, docId))
    .returning(docColumns);
  if (!updated) throw new DocNotFoundError();
  await ctx.audit({
    action: archived ? 'doc.archive' : 'doc.unarchive',
    resourceType: 'doc',
    resourceId: updated.id,
  });
  return toDocView(updated);
}

export interface CollaboratorView {
  id: string;
  user_id: string;
  email: string | null;
  role: CollaboratorRole;
}

/** New in v1: the browser plane never had a way to read the list back. */
export async function listCollaborators(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
): Promise<CollaboratorView[]> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const rows = await ctx.db
    .select({
      id: docCollaborators.id,
      userId: docCollaborators.userId,
      role: docCollaborators.role,
      email: users.email,
    })
    .from(docCollaborators)
    .innerJoin(users, eq(users.id, docCollaborators.userId))
    .where(eq(docCollaborators.docId, docId))
    .orderBy(users.email);
  return rows.map((r) => ({ id: r.id, user_id: r.userId, email: r.email, role: asRole(r.role) }));
}

export async function addCollaborator(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  input: { email: string; role: CollaboratorRole },
): Promise<{ id: string; user_id: string; role: CollaboratorRole }> {
  await assertCanAdminister(ctx.acl, actor.id, docId);

  const [target] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (!target) throw new UserNotFoundError();

  const [existing] = await ctx.db
    .select({ id: docCollaborators.id })
    .from(docCollaborators)
    .where(and(eq(docCollaborators.docId, docId), eq(docCollaborators.userId, target.id)))
    .limit(1);
  if (existing) throw new AlreadyCollaboratorError();

  const [row] = await ctx.db
    .insert(docCollaborators)
    .values({ docId, userId: target.id, role: input.role })
    .returning({
      id: docCollaborators.id,
      userId: docCollaborators.userId,
      role: docCollaborators.role,
    });

  await ctx.audit({
    action: 'doc.collaborator.add',
    resourceType: 'doc',
    resourceId: docId,
    metadata: { collaborator_user_id: target.id, role: input.role },
  });
  return { id: row.id, user_id: row.userId, role: asRole(row.role) };
}

export async function removeCollaborator(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  userId: string,
): Promise<void> {
  await assertCanAdminister(ctx.acl, actor.id, docId);
  const deleted = await ctx.db
    .delete(docCollaborators)
    .where(and(eq(docCollaborators.docId, docId), eq(docCollaborators.userId, userId)))
    .returning({ id: docCollaborators.id });
  if (deleted.length === 0) throw new CollaboratorNotFoundError();
  await ctx.audit({
    action: 'doc.collaborator.remove',
    resourceType: 'doc',
    resourceId: docId,
    metadata: { collaborator_user_id: userId },
  });
}
