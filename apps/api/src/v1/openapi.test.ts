import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { enforceDocumentedRoutes } from './openapi.js';

/**
 * The claim under test is "an undocumented /api/v1 route cannot reach
 * production". That is only true if the check actually throws, so this asserts
 * the throw directly rather than trusting that the real plane happens to boot.
 */
async function boots(register: (app: ReturnType<typeof Fastify>) => void): Promise<string | null> {
  const app = Fastify();
  // The real plane sets these; without them a zod `response` schema cannot be
  // compiled and every case here would fail for the wrong reason.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  enforceDocumentedRoutes(app);
  register(app);
  try {
    await app.ready();
    return null;
  } catch (err) {
    return (err as Error).message;
  } finally {
    await app.close();
  }
}

const ok = { schema: { summary: 'x', tags: ['t'], response: { 200: z.object({}) } } };

describe('enforceDocumentedRoutes', () => {
  it('lets a fully documented route boot', async () => {
    expect(await boots((app) => app.get('/documented', ok, async () => ({})))).toBeNull();
  });

  it.each([
    ['no schema at all', undefined],
    ['no summary', { schema: { tags: ['t'], response: { 200: z.object({}) } } }],
    ['no tags', { schema: { summary: 'x', response: { 200: z.object({}) } } }],
    ['empty tags', { schema: { summary: 'x', tags: [], response: { 200: z.object({}) } } }],
    ['no response', { schema: { summary: 'x', tags: ['t'] } }],
  ])('refuses to boot when a route has %s', async (_label, opts) => {
    const msg = await boots((app) =>
      opts ? app.get('/bad', opts as never, async () => ({})) : app.get('/bad', async () => ({})),
    );
    expect(msg).toContain('undocumented /api/v1 routes');
    expect(msg).toContain('/bad');
  });

  it('names every offender, not just the first', async () => {
    const msg = await boots((app) => {
      app.get('/one', async () => ({}));
      app.get('/two', async () => ({}));
      app.get('/fine', ok, async () => ({}));
    });
    expect(msg).toContain('/one');
    expect(msg).toContain('/two');
    expect(msg).not.toContain('/fine');
  });

  it('says which parts are missing, so the fix is obvious from the message', async () => {
    const msg = await boots((app) =>
      app.get('/partial', { schema: { summary: 'x' } } as never, async () => ({})),
    );
    expect(msg).toContain('missing: tags, response');
  });

  it('exempts the description and the reference UI, which carry no operation', async () => {
    const msg = await boots((app) => {
      app.get('/openapi.json', async () => ({}));
      app.get('/openapi.yaml', async () => ({}));
      app.get('/reference', async () => ({}));
      app.get('/reference/js/scalar.js', async () => ({}));
    });
    expect(msg).toBeNull();
  });

  it('ignores a route that opts out with schema.hide', async () => {
    expect(
      await boots((app) => app.get('/hidden', { schema: { hide: true } }, async () => ({}))),
    ).toBeNull();
  });

  it('ignores the HEAD Fastify generates alongside each GET', async () => {
    // Fastify adds a HEAD for every GET with `exposeHeadRoutes`; it inherits no
    // schema of its own, so counting it would make every documented GET fail.
    const msg = await boots((app) =>
      app.get('/documented', { ...ok, exposeHeadRoutes: true } as never, async () => ({})),
    );
    expect(msg).toBeNull();
  });
});
