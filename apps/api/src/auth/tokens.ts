// Self-service bearer credentials for the /api/v1 machine plane.
//
// Format: `aeolus_<id>_<secret>`
//   id     — 16 hex chars (8 random bytes). PUBLIC, and the api_tokens primary
//            key, so verifying a presented token is one indexed lookup rather
//            than a scan-and-compare over every live token.
//   secret — 32 random bytes, base64url. Never stored, never re-displayable:
//            the plaintext exists in the response to the minting request and
//            nowhere else, ever.
//
// What is stored is sha256 of the WHOLE presented string, so the id alone
// proves nothing and a stored hash is bound to exactly one id. 256 bits of
// entropy is well past brute force, which is why a plain sha256 (not a KDF)
// is the right shape here — the input is uniform randomness, not a
// human-chosen password.
//
// The `aeolus_` literal prefix is deliberate: secret scanners key off
// prefixes, and a token pasted into a ticket or a chat is then recognisable
// as an Aeolus credential by anyone who sees it, including the person who
// should revoke it.
//
// The Aeolus
// difference is in the preHandler, not here: a token acts as the user who
// minted it, so the existing five-role document ACL applies unchanged on top
// of the scope gate below.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * What a credential is allowed to do on the `/api/v1` plane.
 *
 * `read`  — safe methods only (GET/HEAD/OPTIONS).
 * `write` — everything, which on this API means creating and deleting
 *           documents and files, writing document content, enqueuing
 *           compiles, and restoring checkpoints.
 *
 * The split is by HTTP method rather than a per-route allow-list,
 * deliberately: a route added to `/api/v1` later is covered the day it is
 * added, and the failure mode of forgetting to classify it is a read-only
 * token being denied, not one being over-permitted.
 *
 * Scope is NOT the ACL. A token also carries its minting user's document
 * permissions, and both gates apply — a write-scope token minted by a viewer
 * still cannot write that document.
 */
export const TOKEN_SCOPES = ['read', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * Methods a `read` token may use — RFC 9110's safe methods. Everything else
 * needs `write`. OPTIONS is here because a preflight is not a request for the
 * resource; no route on this API acts on one.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The authorization decision, expressed so that it FAILS CLOSED: a write is
 * permitted only on a scope that is exactly `write`. A row carrying a null,
 * empty, or unrecognised scope — a partial migration, a hand-edited row — is
 * therefore read-only rather than unrestricted.
 */
export function scopeAllows(scope: string | null | undefined, method: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  return scope === 'write';
}

export const TOKEN_PREFIX = 'aeolus_';
const ID_BYTES = 8;
const ID_RE = /^[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SECRET_BYTES = 32;
// base64url of 32 bytes is 43 chars; anything materially shorter was not
// minted here, so we can reject it before touching the database.
const MIN_SECRET_CHARS = 40;

export interface MintedToken {
  /** Public identifier — safe to log, display, and store as the row key. */
  id: string;
  /** The full credential. Shown to its creator once and never persisted. */
  token: string;
  /** sha256(token), hex — this is what the row holds. */
  hash: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintToken(): MintedToken {
  const id = randomBytes(ID_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${TOKEN_PREFIX}${id}_${secret}`;
  return { id, token, hash: hashToken(token) };
}

/**
 * Extract the public id from a presented credential, or null when the string
 * isn't token-shaped at all. Null means "not one of ours" — the caller skips
 * the database lookup entirely, so a flood of junk Authorization headers costs
 * no queries.
 */
export function parseTokenId(presented: string): string | null {
  if (!presented.startsWith(TOKEN_PREFIX)) return null;
  const rest = presented.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep <= 0) return null;
  const id = rest.slice(0, sep);
  if (!ID_RE.test(id)) return null;
  if (rest.length - sep - 1 < MIN_SECRET_CHARS) return null;
  return id;
}

/**
 * Constant-time comparison of a presented token against a stored hash. Both
 * sides are fixed-length sha256 digests, so the compare never leaks length and
 * timingSafeEqual never throws.
 */
export function tokenMatches(presented: string, storedHash: string): boolean {
  if (!HASH_RE.test(storedHash)) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Pull the credential out of an `Authorization: Bearer <token>` header.
 *
 * Bearer rather than a bespoke `x-api-key` header because it is what OpenAPI's
 * `http`/`bearer` security scheme describes natively, every HTTP client has a
 * helper for it, and the reference UI's "Try it" box speaks it.
 */
export function bearerFrom(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

/** Byte length of the random secret, exported for the tests to assert on. */
export const SECRET_ENTROPY_BYTES = SECRET_BYTES;
