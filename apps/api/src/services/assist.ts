import { aiRequests } from '@aeolus/db';

import { assertCanRead } from '../acl.js';
import { streamAssist, type AiClientConfig } from '../ai/client.js';
import { checkQuota } from '../ai/quota.js';
import { checkGlobalSpendCap, recordSpend } from '../ai/spend.js';
import type { Actor } from '../actor.js';
import type { ServiceContext } from './context.js';

/**
 * Claude-assist, for both planes.
 *
 * Unlike every other service here this one streams, so it cannot simply return
 * a value: the caller has to know when the preflight is over and the first
 * byte is about to move, because that is the moment an HTTP status stops being
 * available. The shape that falls out is a **sink**:
 *
 * - Everything that can be an HTTP status — the ACL, the quota, the spend cap,
 *   a missing API key — is checked before `sink.open()` and **thrown**, exactly
 *   like the other services.
 * - After `sink.open()` the response is committed. An upstream failure is no
 *   longer a status code; it is an `error` event on a stream that already
 *   returned 200, and the caller is told through `sink.failed()`.
 *
 * The same split the multipart upload uses for its deferred `read()`: authorize
 * first, touch the wire second.
 */

export interface AssistInput {
  docId: string;
  selection: string;
  instruction: string;
  preferHigherQuality?: boolean;
  errorContext?: string;
}

export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AssistSink {
  /** The preflight passed. Send headers now; nothing after this can be a status. */
  open(): void;
  chunk(text: string): void;
  usage(usage: AiUsage): void;
  /** The model finished. */
  done(): void;
  /** The model did not. The response is already 200; this is stream-level. */
  failed(message: string): void;
}

export class AiUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'ai_unavailable';
  constructor() {
    super('AI service not configured');
  }
}

export class SpendCapError extends Error {
  readonly statusCode = 503;
  readonly code = 'quota_exceeded';
  constructor() {
    super('Global daily spend cap reached');
  }
}

export class QuotaExceededError extends Error {
  readonly statusCode = 429;
  readonly code = 'quota_exceeded';
  constructor(reason: string) {
    super(reason);
  }
}

// A non-numeric value used to parse to NaN, `currentCents < NaN` was always
// false, and every assist answered 503 until someone read the env.
const GLOBAL_DAILY_CAP_USD_CENTS = (() => {
  const raw = process.env.AEOLUS_AI_DAILY_CAP_CENTS;
  if (raw === undefined || raw === '') return 10_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `AEOLUS_AI_DAILY_CAP_CENTS must be a non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
})();

/** What the author sees when the upstream model call fails mid-stream. */
export const ASSIST_FAILED_MESSAGE =
  'Claude could not finish this request. Try again; if it keeps failing, tell an administrator.';

/** Anthropic list prices, USD per million tokens. */
const PRICE_PER_MTOK = {
  input: 3.0,
  cacheWrite: 3.75,
  cacheRead: 0.3,
  output: 15.0,
} as const;

export function computeCostCents(usage: AiUsage): number {
  const costUsd =
    (usage.input_tokens / 1_000_000) * PRICE_PER_MTOK.input +
    (usage.cache_creation_input_tokens / 1_000_000) * PRICE_PER_MTOK.cacheWrite +
    (usage.cache_read_input_tokens / 1_000_000) * PRICE_PER_MTOK.cacheRead +
    (usage.output_tokens / 1_000_000) * PRICE_PER_MTOK.output;
  return Math.ceil(costUsd * 100);
}

function aiConfig(): AiClientConfig | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return { apiKey, baseURL: process.env.ANTHROPIC_BASE_URL };
}

/**
 * Run one assist. Throws before `sink.open()`; reports through the sink after.
 *
 * The quota is per **user**, so a token spends the allowance of whoever minted
 * it — the reason the machine plane needed no new spend control of its own.
 */
export async function assist(
  ctx: ServiceContext,
  actor: Actor,
  input: AssistInput,
  sink: AssistSink,
): Promise<void> {
  // A document the actor cannot read is 404, per ADR 0003 — the same answer
  // assertCanRead gives everywhere else.
  await assertCanRead(ctx.acl, actor.id, input.docId);

  const config = aiConfig();
  if (!config) throw new AiUnavailableError();

  const spend = await checkGlobalSpendCap(ctx.db, GLOBAL_DAILY_CAP_USD_CENTS);
  if (!spend.allowed) throw new SpendCapError();

  const quota = await checkQuota(ctx.db, actor.id);
  if (!quota.allowed) throw new QuotaExceededError(quota.reason ?? 'Quota exceeded');

  sink.open();

  // Boxed so TypeScript does not narrow it to null across the closure.
  const capture: { usage: AiUsage | null } = { usage: null };
  let failure: string | null = null;

  try {
    await streamAssist(
      config,
      {
        selection: input.selection,
        instruction: input.instruction,
        preferHigherQuality: input.preferHigherQuality,
        errorContext: input.errorContext,
      },
      {
        onChunk: (text) => sink.chunk(text),
        onUsage: (usage) => {
          capture.usage = usage;
          sink.usage(usage);
        },
      },
    );
    sink.done();
  } catch (err) {
    // The SDK's message can name the model, the upstream status and request
    // id; the author gets one sentence and the operator gets the cause.
    ctx.log.error({ err }, 'assist: upstream request failed');
    failure = ASSIST_FAILED_MESSAGE;
    sink.failed(failure);
  }

  // The ledger is written after the stream is closed, deliberately: DB latency
  // on the aiRequests insert plus the ai_global_spend upsert used to hold the
  // response open past the last chunk. Nothing here can reach the client, so a
  // failure is logged, not raised.
  const usage = capture.usage;
  if (!usage) return;
  const costCents = computeCostCents(usage);
  try {
    await ctx.db.insert(aiRequests).values({
      userId: actor.id,
      docId: input.docId,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens: usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
      costUsdCents: costCents,
      instruction: input.instruction,
      // The stream itself completed even if the model errored mid-way; the
      // tokens were spent either way and the ledger is a spend record.
      status: failure ? 'error' : 'success',
    });
    await recordSpend(ctx.db, costCents);
  } catch (err) {
    ctx.log.error({ err }, 'ai/assist ledger write failed');
  }

  // Audited as well as billed. The ledger answers "what did this cost"; the
  // audit trail answers "who asked", and carries `via: api_token` for a call
  // that came in over /api/v1 — the question the ledger cannot answer.
  await ctx.audit({
    action: 'ai.assist',
    resourceType: 'doc',
    resourceId: input.docId,
    metadata: {
      instruction_bytes: Buffer.byteLength(input.instruction),
      selection_bytes: Buffer.byteLength(input.selection),
      cost_usd_cents: costCents,
      status: failure ? 'error' : 'success',
    },
  });
}
