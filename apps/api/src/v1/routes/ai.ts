import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { sseSink } from '../../routes/ai.js';
import { assist } from '../../services/assist.js';
import { serviceContext } from '../../services/context.js';
import { errorResponses } from '../schemas.js';
import { actorOf } from '../authenticate.js';

/**
 * Claude-assist on the machine plane.
 *
 * The one streaming operation here, and the one whose contract a response
 * schema cannot express: the body is an SSE stream, so nothing this route
 * returns ever passes through a serialiser. Rather than declare a shape that
 * would never be enforced, the 200 is declared as `text/event-stream` and the
 * event grammar is documented as prose — in the description below and at
 * length in `docs/API.md`.
 *
 * The spend control needed no new code. A token acts as the user who minted
 * it, so an assist driven by automation draws down that person's hourly and
 * daily quota exactly as their own editing does; `GET /api/v1/ai/quota`
 * reports what is left.
 */

const AssistBody = z
  .object({
    doc_id: z.uuid().describe('The document the selection came from. Read access is required.'),
    selection: z.string().min(1).max(100_000).describe('The text to work on.'),
    instruction: z.string().min(1).max(2000).describe('What to do with it.'),
    prefer_higher_quality: z
      .boolean()
      .optional()
      .describe('Ask for the slower, better model. Costs more of the same quota.'),
    error_context: z
      .string()
      .max(16_384)
      .optional()
      .describe('A compile-error tail, which switches the prompt from rewrite to fix.'),
  })
  .meta({ id: 'AssistRequest' });

export async function registerV1AiRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.post(
    '/ai/assist',
    {
      schema: {
        tags: ['ai'],
        summary: 'Stream a Claude-assist suggestion',
        description:
          'Server-Sent Events. The response is `text/event-stream`; read it with ' +
          'an SSE client, not `response.json()`.\n\n' +
          'Four event types, each with a JSON `data` payload:\n\n' +
          '| `event:` | `data:` | |\n' +
          '|---|---|---|\n' +
          '| `chunk` | `{"text":"…"}` | A fragment of the suggestion. Concatenate in order. |\n' +
          '| `usage` | `{"usage":{"input_tokens":…,"output_tokens":…,"cache_creation_input_tokens":…,"cache_read_input_tokens":…}}` | Emitted once, near the end. |\n' +
          '| `done` | `{}` | The suggestion is complete. |\n' +
          '| `error` | `{"error":"…"}` | The model failed **after** the stream opened. |\n\n' +
          'Lines beginning `:` are keepalive comments, sent every 15s so an idle ' +
          'proxy does not drop a long generation; ignore them.\n\n' +
          '**A failure can arrive two ways.** Anything checkable before the first ' +
          'byte — the document ACL, your quota, the global spend cap, an ' +
          'unconfigured service — is an ordinary JSON status response. Once the ' +
          'stream is open the status is already 200, so a later failure can only ' +
          'be an `error` event. A client that treats 200 as success will report ' +
          'a failed generation as an empty one.\n\n' +
          'The quota is per user, not per token. Requires a write-scope token.',
        body: AssistBody,
        produces: ['text/event-stream'],
        response: {
          200: z
            .string()
            .describe(
              'An SSE stream. See the description for the event grammar; the body ' +
                'is not JSON and this is a text/event-stream, not a string.',
            )
            .meta({ id: 'AssistStream' }),
          ...errorResponses(),
          403: z
            .object({ error: z.enum(['read_only_token', 'forbidden']), message: z.string() })
            .meta({ id: 'AssistForbiddenResponse' })
            .describe('`read_only_token` (scope) or `forbidden` (document ACL).'),
          429: z
            .object({ error: z.enum(['rate_limited', 'quota_exceeded']), message: z.string() })
            .meta({ id: 'AssistRateLimitedResponse' })
            .describe(
              "`rate_limited` is the plane's 120/min budget and carries `retry-after`. " +
                '`quota_exceeded` is your Claude-assist allowance and carries no header ' +
                'at all — the answer is not "wait a moment". Read `GET /ai/quota`.',
            ),
          404: z
            .object({ error: z.literal('not_found'), message: z.string() })
            .meta({ id: 'AssistNotFoundResponse' })
            .describe('No such document, or none you can read (ADR 0003).'),
          503: z
            .object({ error: z.enum(['ai_unavailable', 'quota_exceeded']), message: z.string() })
            .meta({ id: 'AssistUnavailableResponse' })
            .describe(
              '`ai_unavailable`: no API key configured. `quota_exceeded` at 503: ' +
                'the whole deployment hit its daily spend cap, not you.',
            ),
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = request.body;
      await assist(
        serviceContext(app, request, actor),
        actor,
        {
          docId: body.doc_id,
          selection: body.selection,
          instruction: body.instruction,
          preferHigherQuality: body.prefer_higher_quality,
          errorContext: body.error_context,
        },
        // The same sink the editor's stream is framed with, so the two planes
        // cannot describe the same events differently.
        sseSink(reply),
      );
    },
  );
}
