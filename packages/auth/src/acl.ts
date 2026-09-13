import { and, eq } from 'drizzle-orm';

import { docCollaborators, docs, users, type Database } from '@aeolus/db';

export type DocRole = 'owner' | 'editor' | 'viewer';
export type ResolvedRole = DocRole | 'none';

export interface AclUserRow {
  id: string;
  isAdmin: boolean;
}

export interface AclDocRow {
  id: string;
  ownerId: string;
  deletedAt: Date | null;
  // Set when an owner/admin archives the doc. Read-only is enforced
  // at the API surface via `assertCanWrite` throwing
  // `DocArchivedError`; reads (compile, view, download, history) are
  // still allowed. Templates use `isTemplateDoc`; soft-delete uses
  // `deletedAt`; this is the third independent flag.
  archivedAt: Date | null;
  isTemplateDoc: boolean;
  // Threaded out so callers that already pay for assertCanRead /
  // assertCanWrite don't issue a second SELECT just to read engine.
  engine: string;
}

export interface AclDeps {
  getUser(userId: string): Promise<AclUserRow | null>;
  getDoc(docId: string): Promise<AclDocRow | null>;
  getCollaboratorRole(docId: string, userId: string): Promise<'editor' | 'viewer' | null>;
}

export class DocNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
  constructor() {
    super('Document not found');
    this.name = 'DocNotFoundError';
  }
}

export class DocForbiddenError extends Error {
  readonly statusCode = 403;
  readonly code = 'forbidden';
  constructor() {
    super('You do not have permission to perform this action');
    this.name = 'DocForbiddenError';
  }
}

// Archive state is enforced separately from role: the caller has
// write permission in principle but the doc is locked. 422 (rather
// than 403) so clients can disambiguate "you don't have access" from
// "the doc is read-only right now". Unarchive lifts the lock.
export class DocArchivedError extends Error {
  readonly statusCode = 422;
  readonly code = 'archived';
  constructor() {
    super('This document is archived and cannot be modified');
    this.name = 'DocArchivedError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Internal: load user + doc + collaborator role in the order
// required by the ACL semantics. Returns the doc alongside the
// resolved role so callers can avoid a second SELECT.
async function resolveRoleAndDoc(
  deps: AclDeps,
  userId: string,
  docId: string,
): Promise<{ role: ResolvedRole; doc: AclDocRow | null }> {
  if (!UUID_RE.test(docId)) return { role: 'none', doc: null };
  const user = await deps.getUser(userId);
  if (!user) return { role: 'none', doc: null };
  const doc = await deps.getDoc(docId);
  if (!doc) return { role: 'none', doc: null };
  if (doc.isTemplateDoc) {
    if (user.isAdmin && doc.deletedAt === null) return { role: 'owner', doc };
    return { role: 'none', doc };
  }
  if (user.isAdmin) return { role: 'owner', doc };
  if (doc.deletedAt !== null) return { role: 'none', doc };
  if (doc.ownerId === userId) return { role: 'owner', doc };
  const collab = await deps.getCollaboratorRole(docId, userId);
  if (collab === 'editor') return { role: 'editor', doc };
  if (collab === 'viewer') return { role: 'viewer', doc };
  return { role: 'none', doc };
}

export async function resolveRole(
  deps: AclDeps,
  userId: string,
  docId: string,
): Promise<ResolvedRole> {
  return (await resolveRoleAndDoc(deps, userId, docId)).role;
}

export async function assertCanRead(
  deps: AclDeps,
  userId: string,
  docId: string,
): Promise<AclDocRow> {
  const { role, doc } = await resolveRoleAndDoc(deps, userId, docId);
  if (role === 'none' || !doc) throw new DocNotFoundError();
  return doc;
}

export async function assertCanWrite(
  deps: AclDeps,
  userId: string,
  docId: string,
): Promise<AclDocRow> {
  const { role, doc } = await resolveRoleAndDoc(deps, userId, docId);
  if ((role === 'owner' || role === 'editor') && doc) {
    // Archive is a doc-level lock that overrides the role grant —
    // owners and editors both bounce off it. The unarchive route
    // intentionally goes through `resolveRole` instead so it can
    // lift the lock without tripping it.
    if (doc.archivedAt !== null) throw new DocArchivedError();
    return doc;
  }
  if (role === 'viewer') throw new DocForbiddenError();
  throw new DocNotFoundError();
}

/**
 * Owner-or-admin, deliberately NOT subject to the archive lock.
 *
 * This is the `resolveRole` → "none is 404, non-owner is 403" ladder that was
 * written out five times in `routes/docs.ts` (delete, archive, unarchive,
 * add-collaborator, remove-collaborator). It cannot be `assertCanWrite`: an
 * editor passes that and must not pass this, and archive/unarchive have to be
 * able to lift the very lock `assertCanWrite` enforces.
 *
 * `resolveRole` already resolves an admin to `owner` on any non-template doc,
 * so admin override comes for free.
 */
export async function assertCanAdminister(
  deps: AclDeps,
  userId: string,
  docId: string,
): Promise<AclDocRow> {
  const { role, doc } = await resolveRoleAndDoc(deps, userId, docId);
  // 404 rather than 403 for a non-participant: ADR 0003 — never confirm a
  // document exists to someone who cannot see it.
  if (role === 'none' || !doc) throw new DocNotFoundError();
  if (role !== 'owner') throw new DocForbiddenError();
  return doc;
}

export function createDbAclDeps(db: Database): AclDeps {
  return {
    async getUser(userId) {
      const [row] = await db
        .select({ id: users.id, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row ?? null;
    },
    async getDoc(docId) {
      const [row] = await db
        .select({
          id: docs.id,
          ownerId: docs.ownerId,
          deletedAt: docs.deletedAt,
          archivedAt: docs.archivedAt,
          isTemplateDoc: docs.isTemplateDoc,
          engine: docs.engine,
        })
        .from(docs)
        .where(eq(docs.id, docId))
        .limit(1);
      return row ?? null;
    },
    async getCollaboratorRole(docId, userId) {
      const [row] = await db
        .select({ role: docCollaborators.role })
        .from(docCollaborators)
        .where(and(eq(docCollaborators.docId, docId), eq(docCollaborators.userId, userId)))
        .limit(1);
      if (!row) return null;
      return row.role === 'editor' ? 'editor' : 'viewer';
    },
  };
}
