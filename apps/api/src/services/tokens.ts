import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { apiTokens, type Database } from '@aeolus/db';

import { hashToken, mintToken, type TokenScope } from '../auth/tokens.js';

/**
 * A token as anyone is ever allowed to see it after creation. Note what is
 * absent: `token_hash`. It is the verification input, so it stays out of
 * responses, URLs and logs exactly as the plaintext does.
 */
export interface TokenView {
  id: string;
  name: string;
  scope: TokenScope;
  created_by: string;
  created_by_email: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface TokenRow {
  id: string;
  name: string;
  scope: string;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * Anything not exactly 'write' reads as 'read'. The same fail-closed rule as
 * `scopeAllows`, applied at the presentation edge so a hand-edited row cannot
 * display as more powerful than it will actually behave.
 */
function viewScope(scope: string): TokenScope {
  return scope === 'write' ? 'write' : 'read';
}

function toView(r: TokenRow): TokenView {
  return {
    id: r.id,
    name: r.name,
    scope: viewScope(r.scope),
    created_by: r.createdBy,
    created_by_email: r.createdByEmail,
    created_at: r.createdAt.toISOString(),
    last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  };
}

const VIEW_COLUMNS = {
  id: apiTokens.id,
  name: apiTokens.name,
  scope: apiTokens.scope,
  createdBy: apiTokens.createdBy,
  createdByEmail: apiTokens.createdByEmail,
  createdAt: apiTokens.createdAt,
  lastUsedAt: apiTokens.lastUsedAt,
} as const;

/**
 * Every token, newest first — not just the caller's.
 *
 * Deliberate: a token authorises writes against
 * shared documents, so who holds one is operational information rather than
 * personal, and a revoke that waits for its owner to be reachable is a revoke
 * that does not happen.
 */
export async function listTokens(db: Database): Promise<TokenView[]> {
  const rows = await db.select(VIEW_COLUMNS).from(apiTokens).orderBy(desc(apiTokens.createdAt));
  return rows.map(toView);
}

export async function createToken(
  db: Database,
  input: { name: string; scope: TokenScope; userId: string; userEmail: string | null },
): Promise<{ token: string; created: TokenView }> {
  const minted = mintToken();
  const [row] = await db
    .insert(apiTokens)
    .values({
      id: minted.id,
      name: input.name,
      tokenHash: minted.hash,
      scope: input.scope,
      createdBy: input.userId,
      createdByEmail: input.userEmail,
    })
    .returning(VIEW_COLUMNS);
  return { token: minted.token, created: toView(row) };
}

/**
 * Revoke by deleting the row. The hash IS the credential, so there is no
 * second meaning of "revoked" to keep in sync — this diverges from
 * a soft `enabled = false`, which is worth having only when a separate
 * authorizer reads the table. Returns the deleted row, or null if it was not
 * there (so the caller can 404 rather than report a success it did not cause).
 */
export async function revokeToken(db: Database, id: string): Promise<TokenView | null> {
  const [row] = await db.delete(apiTokens).where(eq(apiTokens.id, id)).returning(VIEW_COLUMNS);
  return row ? toView(row) : null;
}

/** The verification read. Returns the hash, so it is never handed to a route. */
export async function findTokenForAuth(
  db: Database,
  id: string,
): Promise<{
  id: string;
  name: string;
  scope: string;
  tokenHash: string;
  createdBy: string;
} | null> {
  const [row] = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scope: apiTokens.scope,
      tokenHash: apiTokens.tokenHash,
      createdBy: apiTokens.createdBy,
    })
    .from(apiTokens)
    .where(eq(apiTokens.id, id))
    .limit(1);
  return row ?? null;
}

/** How stale `last_used_at` is allowed to be. */
export const LAST_USED_THROTTLE = '5 minutes';

/**
 * Stamp `last_used_at`, at most once per token per throttle window.
 *
 * The throttle is a SQL predicate rather than an in-memory timestamp because
 * there are several api tasks behind the ALB: an in-process cache would let
 * each of them write once per window. Here the predicate makes it a no-op for
 * every writer but the first.
 */
export async function touchToken(db: Database, id: string): Promise<void> {
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiTokens.id, id),
        or(
          isNull(apiTokens.lastUsedAt),
          lt(apiTokens.lastUsedAt, sql`now() - interval '${sql.raw(LAST_USED_THROTTLE)}'`),
        ),
      ),
    );
}

/** Exported for tests that need to assert on what was stored. */
export { hashToken };
