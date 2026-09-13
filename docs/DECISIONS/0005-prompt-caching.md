# 0005 — Prompt caching for Claude-assist

- **Status**: accepted
- **Date**: 2026-04-15

## Context

Aeolus uses a single instance-wide Anthropic API key shared
across all users. Every `/ai/assist` call sends the same system
prompt (writing-assistant persona + house style) as the
prefix. Without caching, each request pays full input-token cost
for this stable prefix — at scale this dominates the bill because
the per-user content (selected text + instruction) is typically
small relative to the system prompt.

## Decision

We use the Anthropic SDK's prompt caching (`cache_control: {type:
"ephemeral"}`) on two system-prompt content blocks:

1. **Base system prompt** (`SYSTEM_PROMPT`) — the writing-assistant
   persona, output formatting rules, and LaTeX/Typst conventions.
2. **House style** (`BRAND_CONTEXT`) — tone, voice, and style
   guidelines that remain constant across all requests.

Both blocks are frozen string literals with no per-request
interpolation (no timestamps, user IDs, or request IDs). This
guarantees a deterministic byte prefix across all calls, which is
the invariant that makes caching work (prompt caching is a strict
prefix match — any byte change invalidates everything after it).

The per-request content (user's selected text and instruction)
comes after the cache breakpoints in the `messages` array, so it
does not invalidate the cached prefix.

We use the default 5-minute TTL (`ephemeral`). Given the
collaborative nature of the editor, multiple users are likely to
issue assist requests within any 5-minute window, so cache reads
will be frequent enough to justify the 1.25x write premium.

### Verification

The integration test (`tests/integration/ai.assist.test.ts`)
runs against a mock Anthropic server that:

- Rejects requests whose system blocks lack `cache_control`.
- Reports `cache_creation_input_tokens > 0` on the first request
  for a given system-prompt hash.
- Reports `cache_read_input_tokens > 0` on subsequent requests
  with the same system-prompt hash.

The test asserts both values, confirming the caching mechanism
works end-to-end.

### Cost model

- Cache write: 1.25x base input price (paid once per 5-minute
  window).
- Cache read: 0.1x base input price (paid on every subsequent
  request within the TTL).
- Break-even: 2 requests within 5 minutes (1.25x + 0.1x = 1.35x
  vs 2x uncached).

The default per-user quota is 30 requests per hour
(`DEFAULT_LIMITS` in `apps/api/src/ai/quota.ts`), and every user's
requests share one cached prefix, so on an instance with more than one
active author cache hits dominate.

## Consequences

- Both blocks must remain frozen strings. Dynamic context (e.g.
  template-specific preambles) goes into `messages`, not `system`.
- If we later add per-user or per-template system-prompt segments,
  they must go after the last `cache_control` breakpoint or be
  appended as user messages.
- The mock Anthropic server in tests enforces cache-block presence;
  removing `cache_control` from the client will fail the test.

## References

- Anthropic's prompt-caching documentation:
  <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- `apps/api/src/ai/client.ts` — implementation
- `tests/integration/ai.assist.test.ts` — verification
