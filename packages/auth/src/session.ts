import { createHash, randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { sessions, type Database } from '@aeolus/db';

const IDLE_TTL_SECONDS = 12 * 60 * 60;
const ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60;
const ROTATION_GRACE_SECONDS = 10;

const COOKIE_NAME = 'aeolus_session';

export interface SessionRecord {
  userId: string;
  createdAt: number;
  absoluteExpiresAt: number;
}

export interface SessionStore {
  create(userId: string): Promise<{ token: string; record: SessionRecord }>;
  // Like create(), but the resulting session row carries
  // disable_rotation = true: touch() returns the same token instead
  // of rotating it. Intended for operator tooling that holds a token
  // across many calls (debug-compile.mjs and friends). Standard
  // expires_at + idle TTL still apply.
  createBot(userId: string): Promise<{ token: string; record: SessionRecord }>;
  get(token: string): Promise<SessionRecord | null>;
  touch(token: string): Promise<{ token: string; record: SessionRecord } | null>;
  destroy(token: string): Promise<void>;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function isIdleExpired(lastSeenAt: Date, now: Date): boolean {
  return (now.getTime() - lastSeenAt.getTime()) / 1000 >= IDLE_TTL_SECONDS;
}

// Postgres-backed session store. Sessions live in the `sessions` table:
//   - tokenHash    SHA-256(opaque cookie value)
//   - expiresAt    absolute hard expiry (30d after issue)
//   - lastSeenAt   sliding window for the 12h idle TTL
// Rotation: on touch() the previous row's lastSeenAt is rewound so it
// expires from the idle perspective in ROTATION_GRACE_SECONDS, mirroring
// the Redis-backed implementation's rotation grace.

export function createSessionStore(db: Database): SessionStore {
  return {
    async create(userId) {
      const token = generateToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ABSOLUTE_TTL_SECONDS * 1000);
      const [row] = await db
        .insert(sessions)
        .values({
          userId,
          tokenHash: hashToken(token),
          expiresAt,
          lastSeenAt: now,
        })
        .returning({ createdAt: sessions.createdAt });
      const record: SessionRecord = {
        userId,
        createdAt: toUnixSeconds(row.createdAt),
        absoluteExpiresAt: toUnixSeconds(expiresAt),
      };
      return { token, record };
    },

    async createBot(userId) {
      const token = generateToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ABSOLUTE_TTL_SECONDS * 1000);
      const [row] = await db
        .insert(sessions)
        .values({
          userId,
          tokenHash: hashToken(token),
          expiresAt,
          lastSeenAt: now,
          disableRotation: true,
        })
        .returning({ createdAt: sessions.createdAt });
      const record: SessionRecord = {
        userId,
        createdAt: toUnixSeconds(row.createdAt),
        absoluteExpiresAt: toUnixSeconds(expiresAt),
      };
      return { token, record };
    },

    async get(token) {
      const tokenHash = hashToken(token);
      const now = new Date();
      const [row] = await db
        .select({
          userId: sessions.userId,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
          lastSeenAt: sessions.lastSeenAt,
        })
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      if (now >= row.expiresAt || isIdleExpired(row.lastSeenAt, now)) {
        await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
        return null;
      }
      return {
        userId: row.userId,
        createdAt: toUnixSeconds(row.createdAt),
        absoluteExpiresAt: toUnixSeconds(row.expiresAt),
      };
    },

    async touch(token) {
      const oldHash = hashToken(token);
      const now = new Date();
      const [row] = await db
        .select({
          userId: sessions.userId,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
          lastSeenAt: sessions.lastSeenAt,
          disableRotation: sessions.disableRotation,
        })
        .from(sessions)
        .where(eq(sessions.tokenHash, oldHash))
        .limit(1);
      if (!row) return null;
      if (now >= row.expiresAt || isIdleExpired(row.lastSeenAt, now)) {
        await db.delete(sessions).where(eq(sessions.tokenHash, oldHash));
        return null;
      }
      // Bot sessions skip token rotation — operator tooling holds the
      // same token across many calls. Just bump lastSeenAt to push out
      // the idle window and return the original token unchanged.
      if (row.disableRotation) {
        await db
          .update(sessions)
          .set({ lastSeenAt: now, updatedAt: now })
          .where(eq(sessions.tokenHash, oldHash));
        return {
          token,
          record: {
            userId: row.userId,
            createdAt: toUnixSeconds(row.createdAt),
            absoluteExpiresAt: toUnixSeconds(row.expiresAt),
          },
        };
      }
      const oldExpireMarker = new Date(
        now.getTime() - (IDLE_TTL_SECONDS - ROTATION_GRACE_SECONDS) * 1000,
      );
      await db
        .update(sessions)
        .set({ lastSeenAt: oldExpireMarker, updatedAt: now })
        .where(eq(sessions.tokenHash, oldHash));
      const nextToken = generateToken();
      await db.insert(sessions).values({
        userId: row.userId,
        tokenHash: hashToken(nextToken),
        expiresAt: row.expiresAt,
        lastSeenAt: now,
      });
      return {
        token: nextToken,
        record: {
          userId: row.userId,
          createdAt: toUnixSeconds(row.createdAt),
          absoluteExpiresAt: toUnixSeconds(row.expiresAt),
        },
      };
    },

    async destroy(token) {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    },
  };
}

// Sweeps absolutely-expired or long-idle session rows. Call this on a
// timer (or every few hundred requests) so the table doesn't grow
// unbounded. Returns the number of rows deleted. This is a maintenance
// helper, not load-bearing for correctness — get/touch already lazily
// remove expired rows on read.
export async function purgeExpiredSessions(db: Database): Promise<number> {
  const idleCutoff = new Date(Date.now() - IDLE_TTL_SECONDS * 1000);
  const result = await db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} <= now() OR ${sessions.lastSeenAt} <= ${idleCutoff}`);
  // drizzle's NodePgDatabase delete returns a QueryResult; rowCount may be null.
  const rowCount = (result as unknown as { rowCount?: number | null }).rowCount;
  return rowCount ?? 0;
}

export const sessionConstants = {
  COOKIE_NAME,
  IDLE_TTL_SECONDS,
  ABSOLUTE_TTL_SECONDS,
};

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'strict';
  path: '/';
  secure: boolean;
  signed: true;
  maxAge: number;
  domain?: string;
}

// Cookie Domain tells the browser which hosts to send the cookie to. Unset,
// the cookie is host-only — exactly the host that issued it — which is right
// for the bundled stack, where one reverse proxy fronts both the api and the
// websocket process on a single origin.
//
// Split them across subdomains and the upgrade sees no cookie at all: the
// WebSocket connects, is rejected with policy code 1008, and the editor
// silently stops saving. Setting the domain to the shared parent zone fixes
// it. SameSite=Strict still holds, because both subdomains share a
// registrable domain.
export function sessionCookieOptions(secure: boolean, domain?: string): CookieOptions {
  const opts: CookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure,
    signed: true,
    maxAge: IDLE_TTL_SECONDS,
  };
  if (domain) opts.domain = domain;
  return opts;
}
