import { eq, sql } from 'drizzle-orm';

import {
  checkPassphrase,
  generatePassphrase,
  hashPassphrase,
  needsRehash,
  verifyPassphrase,
} from '@aeolus/auth';
import { users, type Database } from '@aeolus/db';

// Passphrase authentication. Everything that touches `users.passphrase_hash`
// lives here; the routes in routes/auth.ts only translate these errors into
// status codes.

/** Consecutive failures before the account stops answering at all. */
export const MAX_FAILED_ATTEMPTS = 10;
/** How long a locked account stays locked. */
export const LOCKOUT_MS = 15 * 60 * 1000;

// Verified against this when the email is unknown, so a request for a
// non-existent account costs the same time as a wrong passphrase. Without it
// the response time answers "does this address have an account here".
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'Y2Fubm90IG1hdGNoIGFueXRoaW5nIC0gdGhpcyBpcyBhIGZpeGVkIGRlY295IHZhbHVlIGZvcg';

export class InvalidCredentialsError extends Error {
  readonly statusCode = 401;
  readonly code = 'invalid_credentials';
  constructor() {
    super('That email and passphrase do not match an account.');
  }
}

export class AccountLockedError extends Error {
  readonly statusCode = 429;
  readonly code = 'account_locked';
  constructor(readonly retryAfterSeconds: number) {
    super('Too many failed attempts. Try again later.');
  }
}

export class AccountDisabledError extends Error {
  readonly statusCode = 403;
  readonly code = 'account_disabled';
  constructor() {
    super('This account has been disabled.');
  }
}

export class WeakPassphraseError extends Error {
  readonly statusCode = 422;
  readonly code = 'weak_passphrase';
  readonly payload: { problems: string[] };
  constructor(problems: string[]) {
    super(problems[0] ?? 'That passphrase is not strong enough.');
    this.payload = { problems };
  }
}

export interface AuthenticatedIdentity {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  mustSetPassphrase: boolean;
}

/**
 * Check an email and passphrase. Throws `InvalidCredentialsError` for both an
 * unknown address and a wrong passphrase — the caller must not be able to
 * enumerate accounts.
 */
export async function authenticate(
  db: Database,
  input: { email: string; passphrase: string },
): Promise<AuthenticatedIdentity> {
  const email = input.email.trim().toLowerCase();
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      passphraseHash: users.passphraseHash,
      mustSetPassphrase: users.mustSetPassphrase,
      disabledAt: users.disabledAt,
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!row) {
    await verifyPassphrase(input.passphrase, DUMMY_HASH);
    throw new InvalidCredentialsError();
  }
  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    throw new AccountLockedError(Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000));
  }

  const ok = await verifyPassphrase(input.passphrase, row.passphraseHash);
  if (!ok) {
    const attempts = row.failedAttempts + 1;
    await db
      .update(users)
      .set({
        failedAttempts: attempts,
        lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.id));
    throw new InvalidCredentialsError();
  }

  // Only after the passphrase checks out: a disabled account must not be
  // distinguishable from a wrong passphrase by anyone who does not hold the
  // credential.
  if (row.disabledAt !== null) {
    throw new AccountDisabledError();
  }

  const patch: Record<string, unknown> = { failedAttempts: 0, lockedUntil: null };
  // Transparently upgrade a hash made with older parameters.
  if (needsRehash(row.passphraseHash)) {
    patch.passphraseHash = await hashPassphrase(input.passphrase);
  }
  if (row.failedAttempts !== 0 || row.lockedUntil !== null || patch.passphraseHash) {
    await db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, row.id));
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: row.isAdmin,
    mustSetPassphrase: row.mustSetPassphrase,
  };
}

/**
 * Set a new passphrase for a user who is already signed in. The current one is
 * required — a stolen session must not be enough to take the account over —
 * except when the user is still on a system-generated credential, where the
 * login that got them here just proved it.
 */
export async function setPassphrase(
  db: Database,
  userId: string,
  input: { current?: string; next: string },
): Promise<void> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passphraseHash: users.passphraseHash,
      mustSetPassphrase: users.mustSetPassphrase,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new InvalidCredentialsError();

  if (!row.mustSetPassphrase) {
    const ok = await verifyPassphrase(input.current ?? '', row.passphraseHash);
    if (!ok) throw new InvalidCredentialsError();
  }

  const check = checkPassphrase(input.next, { email: row.email, name: row.name });
  if (!check.ok) throw new WeakPassphraseError(check.problems);
  if (await verifyPassphrase(input.next, row.passphraseHash)) {
    throw new WeakPassphraseError(['That is the passphrase you are already using.']);
  }

  await db
    .update(users)
    .set({
      passphraseHash: await hashPassphrase(input.next),
      passphraseSetAt: new Date(),
      mustSetPassphrase: false,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/**
 * A fresh system-generated credential: the plaintext to show the operator
 * exactly once, and the hash to store. Every account starts life with one of
 * these and is flagged `must_set_passphrase`, so the generated value only ever
 * survives until its owner's first sign-in.
 */
export async function generateInitialCredential(): Promise<{ passphrase: string; hash: string }> {
  const passphrase = generatePassphrase();
  return { passphrase, hash: await hashPassphrase(passphrase) };
}

/**
 * Admin reset: replace a user's credential with a generated one, returned
 * once, and require them to choose their own at next sign-in. There is no
 * self-service reset — that would need outbound mail, which a self-hosted
 * install may not have.
 */
export async function resetPassphrase(
  db: Database,
  targetUserId: string,
): Promise<{ passphrase: string } | null> {
  const { passphrase, hash } = await generateInitialCredential();
  const [updated] = await db
    .update(users)
    .set({
      passphraseHash: hash,
      passphraseSetAt: null,
      mustSetPassphrase: true,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, targetUserId))
    .returning({ id: users.id });
  if (!updated) return null;
  return { passphrase };
}

export interface BootstrapResult {
  created: boolean;
  email: string;
  passphrase?: string;
}

/**
 * First launch: if the instance has no users at all, create the administrator
 * with a generated passphrase so somebody can get in. Returns the passphrase
 * exactly once — the caller prints it and it is never recoverable again.
 *
 * Guarded by the count, so it is a no-op on every subsequent boot and safe to
 * run from all three processes.
 */
export async function bootstrapFirstAdmin(db: Database, email: string): Promise<BootstrapResult> {
  const normalized = email.trim().toLowerCase();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  if (count > 0) return { created: false, email: normalized };

  const { passphrase, hash } = await generateInitialCredential();
  try {
    await db.insert(users).values({
      email: normalized,
      name: 'Administrator',
      isAdmin: true,
      passphraseHash: hash,
      mustSetPassphrase: true,
    });
  } catch {
    // Another process won the race between the count and the insert.
    return { created: false, email: normalized };
  }
  return { created: true, email: normalized, passphrase };
}
