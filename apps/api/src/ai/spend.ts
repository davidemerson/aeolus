import { eq, sql } from 'drizzle-orm';

import { aiGlobalSpend, type Database } from '@aeolus/db';

function todayUtcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

// Increment today's UTC global spend counter. Atomic upsert; safe to
// call from concurrent request handlers. Replaces the Redis INCRBY +
// end-of-day-EX counter previously used here.
export async function recordSpend(db: Database, costUsdCents: number): Promise<void> {
  const day = todayUtcDate();
  await db
    .insert(aiGlobalSpend)
    .values({ dayUtc: day, totalCents: costUsdCents })
    .onConflictDoUpdate({
      target: aiGlobalSpend.dayUtc,
      set: {
        totalCents: sql`${aiGlobalSpend.totalCents} + ${costUsdCents}`,
        updatedAt: sql`now()`,
      },
    });
}

export async function checkGlobalSpendCap(
  db: Database,
  capUsdCents: number,
): Promise<{ allowed: boolean; currentCents: number }> {
  const day = todayUtcDate();
  const [row] = await db
    .select({ totalCents: aiGlobalSpend.totalCents })
    .from(aiGlobalSpend)
    .where(eq(aiGlobalSpend.dayUtc, day))
    .limit(1);
  const currentCents = row?.totalCents ?? 0;
  return { allowed: currentCents < capUsdCents, currentCents };
}
