import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { serviceContext } from '../../services/context.js';
import { MAX_SINGLE_BYTES } from '../../services/file-paths.js';
import {
  createFile,
  deleteFile,
  listFiles,
  readTextFile,
  renameFile,
  uploadFile,
  writeTextFile,
} from '../../services/files.js';
import { errorResponses } from '../schemas.js';
import { actorOf } from '../authenticate.js';
import { drainUpload } from '../../middleware/upload.js';

const File = z
  .object({
    id: z.uuid(),
    path: z.string(),
    kind: z.enum(['text', 'blob', 'folder']),
    yjs_doc_id: z
      .uuid()
      .nullable()
      .describe('The CRDT document backing a text file. Null for blobs and folders.'),
    size_bytes: z
      .number()
      .nullable()
      .describe('For text files this is computed from the CRDT, not stored.'),
    mime_type: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: 'File' });

const DocIdParams = z.object({ id: z.uuid() });
const FileParams = z.object({ id: z.uuid(), fileId: z.uuid() });

const notFound = {
  404: z
    .object({ error: z.literal('not_found'), message: z.string() })
    .meta({ id: 'FileNotFoundResponse' }),
} as const;
const forbidden = {
  403: z
    .object({ error: z.string(), message: z.string() })
    .meta({ id: 'FileForbiddenResponse' })
    .describe('`read_only_token` (scope) or `forbidden` (document ACL). Branch on `error`.'),
} as const;
const unprocessable = {
  422: z
    .object({
      error: z.enum(['archived', 'main_file_locked', 'folder_not_empty', 'not_a_text_file']),
      message: z.string(),
      children: z.number().optional().describe('Set on `folder_not_empty`.'),
    })
    .meta({ id: 'FileUnprocessableResponse' }),
} as const;

/** JSON-Schema twin of schemas.ts ErrorResponse, for the one non-zod route. */
const ERROR_ENVELOPE_JSON_SCHEMA = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: { type: 'string', description: 'Stable, machine-readable code' },
    message: { type: 'string' },
  },
} as const;

export async function registerV1FileRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.get(
    '/docs/:id/files',
    {
      schema: {
        tags: ['files'],
        summary: "List a project's files",
        description:
          'The whole tree — text files, uploaded blobs and folders — ordered by ' +
          'path. `size_bytes` for a text file is computed from its CRDT rather ' +
          'than stored, so it reflects unsaved-to-snapshot edits too.',
        params: DocIdParams,
        response: { 200: z.object({ files: z.array(File) }), ...errorResponses(), ...notFound },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        files: await listFiles(serviceContext(app, request, actor), actor, request.params.id),
      });
    },
  );

  v1.post(
    '/docs/:id/files',
    {
      schema: {
        tags: ['files'],
        summary: 'Create an empty text file or a folder',
        description:
          'Paths are relative, `/`-separated, and reject traversal. A text file ' +
          'gets a fresh CRDT document; a folder gets neither that nor storage.',
        params: DocIdParams,
        body: z.object({
          path: z.string().min(1).max(1024).describe('e.g. `chapters/intro.tex`'),
          kind: z.enum(['text', 'folder']).optional().describe('Defaults to `text`.'),
        }),
        response: {
          201: z.object({
            file: z.object({
              id: z.uuid(),
              path: z.string(),
              kind: z.enum(['text', 'blob', 'folder']),
              yjs_doc_id: z.uuid().nullable(),
              created_at: z.string(),
            }),
          }),
          400: z
            .object({ error: z.enum(['invalid_path', 'invalid_request']), message: z.string() })
            .meta({ id: 'InvalidPathResponse' }),
          409: z
            .object({ error: z.literal('path_taken'), message: z.string() })
            .meta({ id: 'PathTakenResponse' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...unprocessable,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const file = await createFile(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.body,
      );
      return reply.status(201).send({ file });
    },
  );

  v1.get(
    '/docs/:id/files/:fileId/content',
    {
      schema: {
        tags: ['files'],
        summary: "Read a text file's content",
        description:
          'Returns the file as a plain string, materialised from its CRDT — the ' +
          'same source the compile worker reads, so what you get is what would ' +
          'compile. `rev` is the revision you read at: pass it back as `if_rev` ' +
          'on a write to make the write conditional.',
        params: FileParams,
        response: {
          200: z
            .object({ path: z.string(), content: z.string(), rev: z.string() })
            .meta({ id: 'TextContent' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...unprocessable,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(
        await readTextFile(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.params.fileId,
        ),
      );
    },
  );

  v1.put(
    '/docs/:id/files/:fileId/content',
    {
      schema: {
        tags: ['files'],
        summary: "Replace a text file's content",
        description:
          'Applies the new text as a single CRDT transaction against the live ' +
          'document, so a collaborator with the file open stays coherent instead ' +
          'of desynchronising — and is told to re-bootstrap. Supply `if_rev` for ' +
          'optimistic concurrency; omit it and the last writer wins.',
        params: FileParams,
        body: z.object({
          content: z.string(),
          if_rev: z
            .string()
            .optional()
            .describe('The `rev` from a prior read. Refuses with 412 if it moved.'),
        }),
        response: {
          200: z.object({ path: z.string(), rev: z.string() }),
          412: z
            .object({
              error: z.literal('revision_mismatch'),
              message: z.string(),
              rev: z.string().describe('The revision the file is actually at now.'),
            })
            .meta({ id: 'RevisionMismatchResponse' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...unprocessable,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(
        await writeTextFile(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.params.fileId,
          { content: request.body.content, ifRev: request.body.if_rev },
        ),
      );
    },
  );

  v1.patch(
    '/docs/:id/files/:fileId',
    {
      schema: {
        tags: ['files'],
        summary: 'Rename or move a file',
        description:
          "Renaming a folder rewrites every descendant's path in the same " +
          'transaction. The main entrypoint (`main.tex` / `main.typ`) cannot be ' +
          'renamed — the compile worker finds it by path.',
        params: FileParams,
        body: z.object({ path: z.string().min(1).max(1024) }),
        response: {
          200: z.object({ file: z.object({ id: z.uuid(), path: z.string() }) }),
          409: z
            .object({ error: z.literal('path_taken'), message: z.string() })
            .meta({ id: 'RenamePathTakenResponse' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...unprocessable,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        file: await renameFile(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.params.fileId,
          request.body.path,
        ),
      });
    },
  );

  v1.delete(
    '/docs/:id/files/:fileId',
    {
      schema: {
        tags: ['files'],
        summary: 'Delete a file or an empty folder',
        description:
          'A non-empty folder is refused with `folder_not_empty` and a count, ' +
          'rather than cascading deletions you did not ask for. The main ' +
          "entrypoint cannot be deleted. A blob's bytes are only removed when " +
          "nothing else references them — forks share a template's objects.",
        params: FileParams,
        response: {
          204: z.null(),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...unprocessable,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      await deleteFile(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.params.fileId,
      );
      return reply.status(204).send(null);
    },
  );

  // Multipart cannot be described by the zod type provider: request.file()
  // consumes the stream, so the body never reaches a validator. Registered in
  // a nested scope that restores Fastify's default (ajv) compiler, with a
  // plain JSON Schema body that both documents and validates the form.
  await app.register(async (scope) => {
    // BOTH compilers have to be reset, not just the validator. The zod
    // serializer inherited from the parent scope cannot build a plain JSON
    // Schema response and fails at boot with FST_ERR_SCH_SERIALIZATION_BUILD.
    //
    // The validator is a no-op because request.file() has already consumed the
    // body by the time validation would run — the multipart plugin, not a
    // schema, is what enforces the shape here. The JSON Schema on the route is
    // therefore documentation, and is honest about that.
    //
    // It must pass the input THROUGH, not return `{ value: undefined }`: the
    // compiler is applied to every schema part (params, querystring, body), and
    // fastify ≥ 5.9 assigns the validator's returned `value` back onto the
    // request, so a validator that returns undefined wipes `request.params` and
    // the handler's `params.id` read throws — a 500 on every upload (found by
    // the fastify 5.12 bump, 2026-09-12).
    scope.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    scope.setSerializerCompiler(() => (data) => JSON.stringify(data));
    scope.post(
      '/docs/:id/files/upload',
      {
        schema: {
          tags: ['files'],
          summary: 'Upload a binary file',
          description:
            `multipart/form-data. \`file\` is the payload; \`path\` is where it ` +
            `lands (defaults to the uploaded filename). Allowlisted by extension ` +
            `(.png .jpg .jpeg .pdf .bib .cls .sty .ttf .otf .csv), ` +
            `${MAX_SINGLE_BYTES / 1024 / 1024} MB per file and 200 MB per project.`,
          consumes: ['multipart/form-data'],
          params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
          body: {
            type: 'object',
            required: ['file'],
            properties: {
              path: { type: 'string' },
              file: { type: 'string', format: 'binary' },
            },
          },
          // JSON Schema (not zod) because this route registers on the raw
          // instance to keep the multipart parser. The error entries used to
          // be bare `{ type: 'object' }`, which published empty schemas into
          // the OpenAPI document; this is the same envelope the zod routes
          // declare through ErrorResponse.
          response: {
            201: { type: 'object' },
            400: ERROR_ENVELOPE_JSON_SCHEMA,
            401: ERROR_ENVELOPE_JSON_SCHEMA,
            403: ERROR_ENVELOPE_JSON_SCHEMA,
            413: ERROR_ENVELOPE_JSON_SCHEMA,
            422: ERROR_ENVELOPE_JSON_SCHEMA,
            429: ERROR_ENVELOPE_JSON_SCHEMA,
            503: ERROR_ENVELOPE_JSON_SCHEMA,
          },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const file = await uploadFile(
          serviceContext(app, request, actor),
          actor,
          (request.params as { id: string }).id,
          {
            // Deferred: the service authorizes before the stream is touched, so
            // an unauthorized or archived-document upload gets the contract's
            // 403/404/422 rather than a multipart parser error.
            read: async () => {
              const upload = await drainUpload(request);
              return upload ? { rawPath: upload.rawPath, body: upload.body } : null;
            },
          },
        );
        return reply.status(201).send({ file });
      },
    );
  });
}
