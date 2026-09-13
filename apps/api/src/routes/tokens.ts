import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { TOKEN_SCOPES } from '../auth/tokens.js';
import { requireUser } from '../middleware/require-user.js';
import { createToken, listTokens, revokeToken } from '../services/tokens.js';
import { sendError } from '../middleware/reply-errors.js';
import { serviceContext, sessionActor } from '../services/context.js';

const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(120),
  scope: z.enum(TOKEN_SCOPES).default('read'),
});

// The id half of a credential: 16 hex chars. Shape-checked before the database
// is touched, so a junk path segment costs no query.
const TokenIdParams = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) });

/**
 * Token management, on the BROWSER plane only.
 *
 * These routes are session-gated and are deliberately not reachable with a
 * bearer token: a write-scope token that could mint tokens would be able to
 * outlive its own revocation by bootstrapping a successor. Minting requires a
 * passphrase sign-in by a person.
 *
 * Not admin-gated. Every signed-in user can see and revoke every token, which
 * is deliberate: a token authorises writes against
 * shared documents, so who holds one is operational information rather than
 * personal, and a revoke that waits for its owner to be reachable is a revoke
 * that does not happen.
 */
export async function registerTokenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tokens', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;
    return reply.send({ tokens: await listTokens(app.ctx.db) });
  });

  app.post(
    '/tokens',
    { config: { rateLimit: app.ctx.rateLimits.tokenMint } },
    async (request, reply) => {
      const user = await requireUser(app, request, reply);
      if (!user) return;

      // Belt and braces on top of SameSite=Strict. This is the one
      // cookie-authenticated route whose effect is a durable credential, so a
      // cross-site POST that somehow carried the cookie must still not mint one.
      // A missing header (non-browser client, older browser) is allowed through
      // — the cookie's SameSite attribute is still the real control.
      const site = request.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin') {
        return sendError(reply, 403, 'forbidden', 'Cross-site token creation is refused');
      }

      const parsed = CreateTokenBody.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          'invalid_body',
          'name is required; scope must be read or write',
        );
      }

      const ctx = serviceContext(app, request, sessionActor(user));
      const { token, created } = await createToken(ctx.db, {
        name: parsed.data.name,
        scope: parsed.data.scope,
        userId: user.id,
        userEmail: user.email,
      });

      await ctx.audit({
        action: 'token.mint',
        resourceType: 'api_token',
        resourceId: created.id,
        metadata: { name: created.name, scope: created.scope },
      });

      // The only time the plaintext exists outside the caller's clipboard.
      return reply.status(201).send({ token, created });
    },
  );

  app.delete('/tokens/:id', async (request, reply) => {
    const user = await requireUser(app, request, reply);
    if (!user) return;

    const parsed = TokenIdParams.safeParse(request.params);
    if (!parsed.success) return sendError(reply, 404, 'not_found', 'Not found');

    const ctx = serviceContext(app, request, sessionActor(user));
    const revoked = await revokeToken(ctx.db, parsed.data.id);
    if (!revoked) return sendError(reply, 404, 'not_found', 'Not found');

    await ctx.audit({
      action: 'token.revoke',
      resourceType: 'api_token',
      resourceId: revoked.id,
      metadata: {
        name: revoked.name,
        scope: revoked.scope,
        // Who held it. Kept here because the row is gone after this.
        owner_email: revoked.created_by_email,
      },
    });

    // 204, matching every other delete in this API (docs, files, assets).
    // The revoked token's identity is in the audit event, not a response body.
    return reply.status(204).send();
  });
}
