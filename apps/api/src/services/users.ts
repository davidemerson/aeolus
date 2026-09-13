import { desc, eq, max } from 'drizzle-orm';

import { docs, sessions, users, type Database } from '@aeolus/db';

import type { Actor } from '../actor.js';
import type { ServiceContext } from './context.js';
import { generateInitialCredential, resetPassphrase } from './credentials.js';
import { AdminOnlyError, ConflictError, NotFoundError } from './errors.js';

/** User administration, and the one self-service operation. */

export interface UserView {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  disabled_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export class SelfActionError extends Error {
  readonly statusCode = 422;
  constructor(
    readonly code: 'self_delete' | 'self_disable',
    verb: string,
  ) {
    super(`Cannot ${verb} your own account`);
  }
}

const userNotFound = () => new NotFoundError('User');

export async function listUsers(ctx: ServiceContext, actor: Actor): Promise<UserView[]> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  // Fold last-seen into one round trip; a per-user query would be 2N.
  const lastSeen = ctx.db
    .select({
      userId: sessions.userId,
      lastSeenAt: max(sessions.lastSeenAt).as('last_seen_at'),
    })
    .from(sessions)
    .groupBy(sessions.userId)
    .as('last_seen');

  const rows = await ctx.db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      lastSeenAt: lastSeen.lastSeenAt,
    })
    .from(users)
    .leftJoin(lastSeen, eq(lastSeen.userId, users.id))
    .orderBy(desc(users.createdAt));

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    is_admin: r.isAdmin,
    disabled_at: r.disabledAt ? r.disabledAt.toISOString() : null,
    last_seen_at: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }));
}

export interface AdminUserView {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  disabled_at: string | null;
}

export async function updateUser(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  input: { name?: string; isAdmin?: boolean },
): Promise<AdminUserView> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.isAdmin !== undefined) patch.isAdmin = input.isAdmin;

  const [row] = await ctx.db.update(users).set(patch).where(eq(users.id, userId)).returning({
    id: users.id,
    email: users.email,
    name: users.name,
    isAdmin: users.isAdmin,
    disabledAt: users.disabledAt,
  });
  if (!row) throw userNotFound();

  await ctx.audit({
    action: 'user.update',
    resourceType: 'user',
    resourceId: row.id,
    metadata: { ...input },
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    is_admin: row.isAdmin,
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
  };
}

/**
 * Change your own display name. The only user field anyone edits about
 * themselves — email identifies the account and is set when it is created.
 */
export async function updateSelf(
  ctx: ServiceContext,
  actor: Actor,
  input: { name: string },
): Promise<AdminUserView> {
  const [row] = await ctx.db
    .update(users)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(users.id, actor.id))
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
    });
  if (!row) throw userNotFound();
  await ctx.audit({
    action: 'user.update',
    resourceType: 'user',
    resourceId: row.id,
    metadata: { name: input.name, self: true },
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    is_admin: row.isAdmin,
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
  };
}

/**
 * Hard-delete a user, transferring every document they own to the acting
 * admin first.
 *
 * The transfer is not politeness: `docs.owner_id` is RESTRICT since migration
 * 0017 precisely so a delete cannot silently take someone's drafts with it.
 * Both happen in one transaction, so a failure leaves neither half applied.
 */
export async function deleteUser(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
): Promise<{ transferred: number; email: string }> {
  if (!actor.isAdmin) throw new AdminOnlyError();
  if (actor.id === userId) throw new SelfActionError('self_delete', 'delete');

  const outcome = await ctx.db.transaction(async (tx) => {
    const transferred = await tx
      .update(docs)
      .set({ ownerId: actor.id, updatedAt: new Date() })
      .where(eq(docs.ownerId, userId))
      .returning({ id: docs.id });
    const deleted = await tx
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email });
    return { deleted, transferred: transferred.length };
  });
  if (outcome.deleted.length === 0) throw userNotFound();

  await ctx.audit({
    action: 'user.delete',
    resourceType: 'user',
    resourceId: userId,
    metadata: {
      deleted_email: outcome.deleted[0].email,
      docs_transferred: outcome.transferred,
    },
  });
  return { transferred: outcome.transferred, email: outcome.deleted[0].email };
}

/**
 * Disable or re-enable an account.
 *
 * Disabling is the reversible alternative to deleting, and it is immediate:
 * `resolveUser` refuses a disabled user on every request, and so does the
 * `/api/v1` token hook — so it kills their sessions AND their API tokens
 * without either being enumerated.
 */
export async function setUserDisabled(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  disabled: boolean,
): Promise<void> {
  if (!actor.isAdmin) throw new AdminOnlyError();
  if (disabled && actor.id === userId) throw new SelfActionError('self_disable', 'disable');

  const [row] = await ctx.db
    .update(users)
    .set({ disabledAt: disabled ? new Date() : null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!row) throw userNotFound();

  await ctx.audit({
    action: disabled ? 'user.disable' : 'user.enable',
    resourceType: 'user',
    resourceId: row.id,
  });
}

/** An account just created by an admin, with its one-time credential. */
export interface CreatedUser extends AdminUserView {
  /** Shown once. Nothing can recover it afterwards. */
  passphrase: string;
}

/**
 * Create an account. There is no self-service signup and no directory to
 * provision from, so this is the only way a second person gets in: an admin
 * adds the address, hands over the generated passphrase out of band, and the
 * new user is forced to replace it at first sign-in.
 */
export async function createUser(
  ctx: ServiceContext,
  actor: Actor,
  input: { email: string; name?: string | null; isAdmin?: boolean },
): Promise<CreatedUser> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const email = input.email.trim().toLowerCase();
  const [existing] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) throw new ConflictError('An account with that email already exists');

  const { passphrase, hash } = await generateInitialCredential();
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      name: input.name ?? null,
      isAdmin: input.isAdmin ?? false,
      passphraseHash: hash,
      mustSetPassphrase: true,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
    });

  await ctx.audit({
    action: 'user.create',
    resourceType: 'user',
    resourceId: row.id,
    metadata: { email: row.email, is_admin: row.isAdmin },
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    is_admin: row.isAdmin,
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
    passphrase,
  };
}

/**
 * Replace a user's passphrase with a generated one, returned once. This is the
 * whole recovery story: a self-hosted install has no guaranteed outbound mail,
 * so there is no emailed reset link and an admin does it by hand.
 *
 * Every session the target holds is deleted in the same transaction. A reset
 * that left them signed in would not recover an account someone else is
 * already inside.
 */
export async function resetUserPassphrase(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
): Promise<{ passphrase: string }> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const result = await ctx.db.transaction(async (tx) => {
    const reset = await resetPassphrase(tx as unknown as Database, userId);
    if (!reset) return null;
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return reset;
  });
  if (!result) throw userNotFound();

  await ctx.audit({
    action: 'auth.passphrase_reset',
    resourceType: 'user',
    resourceId: userId,
  });
  return result;
}

export interface EnsuredUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  created: boolean;
}

/**
 * Find-or-create a user by email, for the two non-interactive provisioning
 * paths: the admin bot-session mint and the test-only /dev/users route. An
 * existing row is promoted to admin when asked and never demoted here.
 */
export async function ensureUserByEmail(
  db: Database,
  input: { email: string; name?: string | null; isAdmin?: boolean },
): Promise<EnsuredUser> {
  const [existing] = await db
    .select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existing) {
    if (input.isAdmin === true && !existing.isAdmin) {
      await db
        .update(users)
        .set({ isAdmin: true, updatedAt: new Date() })
        .where(eq(users.id, existing.id));
      return { ...existing, isAdmin: true, created: false };
    }
    return { ...existing, created: false };
  }
  const [created] = await db
    .insert(users)
    .values({ email: input.email, name: input.name ?? null, isAdmin: input.isAdmin ?? false })
    .returning({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin });
  return { ...created, created: true };
}
