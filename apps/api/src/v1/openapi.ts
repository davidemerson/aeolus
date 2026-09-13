import scalar from '@scalar/fastify-api-reference';
import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

/** Where the description and the browsable reference live. */
export const OPENAPI_JSON_PATH = '/openapi.json';
export const OPENAPI_YAML_PATH = '/openapi.yaml';
export const REFERENCE_PATH = '/reference';

/**
 * Paths that carry no operation of their own and must not be held to the
 * "every route is documented" rule below.
 */
const META_PATHS = new Set([OPENAPI_JSON_PATH, OPENAPI_YAML_PATH]);
function isMetaPath(url: string): boolean {
  return META_PATHS.has(url) || url === REFERENCE_PATH || url.startsWith(`${REFERENCE_PATH}/`);
}

/**
 * OpenAPI 3.1 for the `/api/v1` plane, generated from the same zod schemas the
 * routes validate and serialize with — so the description cannot drift from the
 * behaviour, because they are the same object.
 *
 * The reference UI is at `/api/v1/reference`, NOT `/api/v1/docs`: `docs` is the
 * documents collection on this API.
 */
/**
 * Does this route's schema hold zod types, or hand-written JSON Schema?
 *
 * Both are legitimate on this plane — see the multipart upload route — and
 * they need different treatment from @fastify/swagger.
 */
function usesZod(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  const isZod = (v: unknown): boolean =>
    !!v && typeof v === 'object' && '_zod' in (v as Record<string, unknown>);
  for (const key of ['body', 'querystring', 'params', 'headers']) {
    if (isZod(s[key])) return true;
  }
  const response = s.response;
  if (response && typeof response === 'object') {
    for (const v of Object.values(response as Record<string, unknown>)) {
      if (isZod(v)) return true;
    }
  }
  return false;
}

/**
 * Fastify's `produces` is route-wide, so declaring `text/event-stream` for the
 * assist stream also relabels that route's 401/403/404/429/503 — which are
 * ordinary JSON. A generated client would then try to parse an error body as an
 * event stream.
 *
 * An error body is never a stream, so the fix needs no per-route marker: on any
 * operation that produces `text/event-stream`, every non-2xx response goes back
 * to `application/json`. Applied to the assembled document rather than the
 * route, because `produces` has already been expanded by then.
 */
function fixStreamingErrorContentTypes(doc: Record<string, unknown>): void {
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return;
  for (const operations of Object.values(paths)) {
    for (const operation of Object.values(operations)) {
      const responses = (operation as { responses?: Record<string, unknown> }).responses;
      if (!responses) continue;
      const streams = Object.values(responses).some(
        (r) => !!(r as { content?: Record<string, unknown> }).content?.['text/event-stream'],
      );
      if (!streams) continue;
      for (const [status, response] of Object.entries(responses)) {
        if (status.startsWith('2')) continue;
        const content = (response as { content?: Record<string, unknown> }).content;
        const stream = content?.['text/event-stream'];
        if (!content || !stream) continue;
        delete content['text/event-stream'];
        content['application/json'] = stream;
      }
    }
  }
}

/**
 * Drop components nothing references.
 *
 * `fastify-type-provider-zod` registers two variants of every schema — the
 * output shape and an `Input` twin — because a zod schema can transform on
 * parse, so what a client sends and what it gets back are not necessarily the
 * same type. Only one of the pair is ever used: a request body `$ref`s the
 * Input, a response `$ref`s the base. The other half is dead weight, and on
 * this plane it was **half the document** — 61 of 122 components, every one of
 * which a client generator would have materialised as a type nobody can reach.
 *
 * The rule is reachability, not a name pattern: walk `$ref`s from `paths`,
 * transitively (a kept schema's own refs must survive), and keep what that
 * reaches. Anything a name-based filter would catch, this catches too, without
 * guessing from a suffix.
 */
function pruneUnreachableSchemas(doc: Record<string, unknown>): void {
  const components = doc.components as { schemas?: Record<string, unknown> } | undefined;
  const schemas = components?.schemas;
  if (!schemas) return;

  const collect = (node: unknown, into: Set<string>): void => {
    if (Array.isArray(node)) {
      for (const v of node) collect(v, into);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
      into.add(ref.slice('#/components/schemas/'.length));
    }
    for (const v of Object.values(node as Record<string, unknown>)) collect(v, into);
  };

  const reachable = new Set<string>();
  collect(doc.paths, reachable);
  const frontier = [...reachable];
  while (frontier.length > 0) {
    const name = frontier.pop()!;
    const schema = schemas[name];
    if (!schema) continue;
    const nested = new Set<string>();
    collect(schema, nested);
    for (const n of nested) {
      if (!reachable.has(n)) {
        reachable.add(n);
        frontier.push(n);
      }
    }
  }

  for (const name of Object.keys(schemas)) {
    if (!reachable.has(name)) delete schemas[name];
  }
}

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Aeolus API',
        version: '1',
        description:
          'The machine-facing plane of Aeolus, a collaborative LaTeX and Typst ' +
          'editor you host yourself.\n\n' +
          "**Scope is not the ACL.** A token carries its minting user's document " +
          'permissions, and both gates apply: a write-scope token minted by someone ' +
          'with viewer access still cannot write that document. See `docs/API.md`.',
      },
      servers: [{ url: '/api/v1' }],
      components: {
        securitySchemes: {
          bearer: {
            type: 'http',
            scheme: 'bearer',
            description:
              'A token minted in the UI at /tokens. Shown once at creation; only a ' +
              'sha256 hash is stored.',
          },
        },
      },
      security: [{ bearer: [] }],
    },
    // @fastify/swagger is fastify-plugin-wrapped, so it decorates the root and
    // sees EVERY route in the app — including the whole schemaless browser
    // plane. Hide anything that is not ours rather than letting it emit a
    // hundred undocumented paths.
    //
    // And within ours, only hand zod schemas to the zod transform. The
    // multipart upload route carries hand-written JSON Schema (a consumed
    // stream cannot be validated by the type provider), and passing that
    // through `jsonSchemaTransform` makes the description route 500 at
    // request time — a failure that shows up nowhere until something fetches
    // the spec.
    transform: (args) => {
      if (!args.url.startsWith('/api/v1/')) {
        return { ...args, schema: { ...args.schema, hide: true } };
      }
      return usesZod(args.schema) ? jsonSchemaTransform(args) : args;
    },
    transformObject: (args) => {
      const doc = jsonSchemaTransformObject(args) as Record<string, unknown>;
      fixStreamingErrorContentTypes(doc);
      pruneUnreachableSchemas(doc);
      return doc as ReturnType<typeof jsonSchemaTransformObject>;
    },
    hideUntagged: true,
  });

  app.get(
    OPENAPI_JSON_PATH,
    { schema: { hide: true }, config: { rateLimit: false } },
    async (_request, reply) => reply.type('application/json').send(app.swagger()),
  );

  app.get(
    OPENAPI_YAML_PATH,
    { schema: { hide: true }, config: { rateLimit: false } },
    async (_request, reply) => reply.type('application/yaml').send(app.swagger({ yaml: true })),
  );

  await app.register(scalar, {
    routePrefix: REFERENCE_PATH,
    configuration: { url: `/api/v1${OPENAPI_JSON_PATH}` },
  });
}

/**
 * Make "fully documented" mechanical rather than remembered.
 *
 * Every `/api/v1` route must declare a `summary`, at least one `tag`, and a
 * `response` map. A route that does not is a **boot failure** — it cannot reach
 * CI, let alone production. The alternative, a lint rule or a review checklist,
 * fails open the first time someone is in a hurry.
 *
 * Must be called BEFORE the routes are registered: `onRoute` fires at
 * registration, so a hook added afterwards sees nothing.
 */
export function enforceDocumentedRoutes(app: FastifyInstance): void {
  const undocumented: string[] = [];

  app.addHook('onRoute', (route) => {
    // HEAD is auto-generated alongside each GET and carries no schema of its
    // own; the meta paths are the description itself.
    if (route.method === 'HEAD' || isMetaPath(route.url.replace('/api/v1', ''))) return;
    if (isMetaPath(route.url)) return;

    const schema = route.schema as
      | { summary?: string; tags?: string[]; response?: unknown; hide?: boolean }
      | undefined;
    if (schema?.hide) return;

    const missing: string[] = [];
    if (!schema?.summary) missing.push('summary');
    if (!schema?.tags?.length) missing.push('tags');
    if (!schema?.response) missing.push('response');
    if (missing.length > 0) {
      undocumented.push(`${route.method} ${route.url} (missing: ${missing.join(', ')})`);
    }
  });

  app.addHook('onReady', async () => {
    if (undocumented.length > 0) {
      throw new Error(
        `undocumented /api/v1 routes — every route needs summary, tags and response:\n  ` +
          undocumented.join('\n  '),
      );
    }
  });
}
