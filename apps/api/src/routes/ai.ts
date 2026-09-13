import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getQuotaStatus } from '../ai/quota.js';
import { assist } from '../services/assist.js';
import { serviceContext, sessionActor } from '../services/context.js';
import { requireUser } from '../middleware/require-user.js';

/**
 * The browser plane's Claude-assist routes — thin callers over
 * `services/assist.ts`, which `/api/v1` also uses.
 *
 * Everything that used to live here — the ACL check, the spend cap, the quota,
 * the cost arithmetic and the ledger write — moved into the service. What is
 * left is the SSE framing, which is transport and belongs on this side of the
 * line.
 */

const AssistBody = z.object({
  docId: z.string().uuid(),
  selection: z.string().min(1).max(100_000),
  instruction: z.string().min(1).max(2000),
  preferHigherQuality: z.boolean().optional(),
  // Compile-error tail (stderr) for the "fix this error" preset.
  // Cap at 16 KiB — Tectonic/Typst stderr is bounded by the worker
  // (MAX_OUTPUT_BYTES = 64 KiB) but the actionable head fits well
  // under this in practice.
  errorContext: z.string().max(16_384).optional(),
});

/**
 * Wire an SSE response to the service's sink.
 *
 * Shared by both planes so the event grammar is defined once: whatever
 * `docs/API.md` documents is what the editor receives too.
 */
export function sseSink(reply: FastifyReply) {
  let keepalive: NodeJS.Timeout | null = null;

  function send(event: string, data: unknown): void {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return {
    open(): void {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        // no-transform stops compressing proxies (cloudfront / ALB
        // gzip filter) from buffering until the response ends.
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx-style hint; some ingress proxies honour it to disable
        // buffering on the response stream.
        'x-accel-buffering': 'no',
      });
      // Force the headers out so clients see the SSE stream open
      // immediately rather than after the first chunk lands.
      reply.raw.flushHeaders();

      // Periodic SSE comment so a long-running stream doesn't get
      // dropped by an idle-timeout proxy and so the server learns of
      // a closed client (the write fails) within ~15 s.
      keepalive = setInterval(() => {
        try {
          reply.raw.write(': keepalive\n\n');
        } catch {
          // Closed socket — the finish below cleans up.
        }
      }, 15_000);
      keepalive.unref();
    },
    chunk(text: string): void {
      send('chunk', { text });
    },
    usage(usage: unknown): void {
      send('usage', { usage });
    },
    done(): void {
      send('done', {});
      this.finish();
    },
    failed(message: string): void {
      send('error', { error: message });
      this.finish();
    },
    finish(): void {
      if (keepalive) clearInterval(keepalive);
      reply.raw.end();
    },
  };
}

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/ai/assist',
    { config: { rateLimit: app.ctx.rateLimits.assist } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await requireUser(app, request, reply);
      if (!user) return;

      const parsed = AssistBody.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'invalid_body', message: parsed.error.issues[0].message });
      }

      const actor = sessionActor(user);
      // Anything the service throws happens before the sink opens, so the global
      // error handler still has a status line to write on.
      await assist(serviceContext(app, request, actor), actor, parsed.data, sseSink(reply));
    },
  );

  app.get('/ai/quota', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    return reply.send(await getQuotaStatus(app.ctx.db, user.id));
  });
}
