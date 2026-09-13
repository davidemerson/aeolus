import { eq, sql } from 'drizzle-orm';

import { aiQuota, aiRequests } from '@aeolus/db';
import type { Database } from '@aeolus/db';

export interface QuotaLimits {
  perHour: number;
  perDay: number;
  tokensPerDay: number;
}

export interface QuotaStatus {
  hourly: { used: number; limit: number };
  daily: { used: number; limit: number };
  dailyTokens: { used: number; limit: number };
}

const DEFAULT_LIMITS: QuotaLimits = {
  perHour: 30,
  perDay: 200,
  tokensPerDay: 50000,
};

export async function getUserLimits(db: Database, userId: string): Promise<QuotaLimits> {
  const [row] = await db
    .select({
      perHour: aiQuota.perHour,
      perDay: aiQuota.perDay,
      tokensPerDay: aiQuota.tokensPerDay,
    })
    .from(aiQuota)
    .where(eq(aiQuota.userId, userId))
    .limit(1);
  return row ?? DEFAULT_LIMITS;
}

export async function getQuotaStatus(db: Database, userId: string): Promise<QuotaStatus> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  // The outer WHERE cutoff has to be the EARLIER of the two so we
  // don't drop rows that fall in the hourly window but precede the
  // current UTC day boundary (e.g. 11:30 PM yesterday at 12:15 AM
  // today). FILTER clauses then pick the per-aggregate slice.
  const windowStart = oneHourAgo < startOfDay ? oneHourAgo : startOfDay;

  // Collapse three serial aggregates into one filtered query, run
  // in parallel with getUserLimits. Backed by
  // ai_requests_user_created_at_idx.
  const [limits, [windowRow]] = await Promise.all([
    getUserLimits(db, userId),
    db
      .select({
        hourlyCount: sql<number>`count(*) filter (where ${aiRequests.createdAt} >= ${oneHourAgo})`,
        dailyCount: sql<number>`count(*) filter (where ${aiRequests.createdAt} >= ${startOfDay})`,
        dailyTokens: sql<number>`coalesce(sum(${aiRequests.inputTokens} + ${aiRequests.outputTokens}) filter (where ${aiRequests.createdAt} >= ${startOfDay}), 0)`,
      })
      .from(aiRequests)
      .where(sql`${aiRequests.userId} = ${userId} AND ${aiRequests.createdAt} >= ${windowStart}`),
  ]);

  return {
    hourly: { used: Number(windowRow?.hourlyCount ?? 0), limit: limits.perHour },
    daily: { used: Number(windowRow?.dailyCount ?? 0), limit: limits.perDay },
    dailyTokens: {
      used: Number(windowRow?.dailyTokens ?? 0),
      limit: limits.tokensPerDay,
    },
  };
}

export async function checkQuota(
  db: Database,
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const status = await getQuotaStatus(db, userId);

  if (status.hourly.used >= status.hourly.limit) {
    return { allowed: false, reason: 'Hourly request limit reached' };
  }
  if (status.daily.used >= status.daily.limit) {
    return { allowed: false, reason: 'Daily request limit reached' };
  }
  if (status.dailyTokens.used >= status.dailyTokens.limit) {
    return { allowed: false, reason: 'Daily token budget exhausted' };
  }
  return { allowed: true };
}
