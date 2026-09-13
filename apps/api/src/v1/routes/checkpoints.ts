import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  createCheckpoint,
  createProjectCheckpoint,
  deleteProjectCheckpoint,
  getCheckpoint,
  listCheckpoints,
  listProjectCheckpoints,
  openCheckpoint,
  restoreCheckpoint,
  restoreProjectCheckpoint,
} from '../../services/checkpoints.js';
import { serviceContext } from '../../services/context.js';
import { errorResponses } from '../schemas.js';
import { actorOf } from '../authenticate.js';

const DocIdParams = z.object({ id: z.uuid() });
const CheckpointParams = z.object({ id: z.uuid(), checkpointId: z.uuid() });
const ProjectParams = z.object({ id: z.uuid(), projectCheckpointId: z.uuid() });

const notFound = {
  404: z
    .object({ error: z.literal('not_found'), message: z.string() })
    .meta({ id: 'CheckpointNotFoundResponse' }),
} as const;
const forbidden = {
  403: z
    .object({ error: z.string(), message: z.string() })
    .meta({ id: 'CheckpointForbiddenResponse' }),
} as const;
const archived = {
  422: z
    .object({ error: z.literal('archived'), message: z.string() })
    .meta({ id: 'CheckpointArchivedResponse' }),
} as const;

const Checkpoint = z
  .object({
    id: z.uuid(),
    label: z.string(),
    kind: z
      .string()
      .describe('`user` for a named checkpoint, `auto_open` for one the editor took.'),
    file_path: z.string(),
    created_by: z.uuid().nullable(),
    created_by_email: z.string().nullable(),
    created_at: z.string(),
  })
  .meta({ id: 'Checkpoint' });

export async function registerV1CheckpointRoutes(app: FastifyInstance): Promise<void> {
  const v1 = app.withTypeProvider<ZodTypeProvider>();

  v1.get(
    '/docs/:id/checkpoints',
    {
      schema: {
        tags: ['checkpoints'],
        summary: "List a file's checkpoints",
        description:
          'Version history for **one file**, newest first. Aeolus keeps history ' +
          'per file, not per project, so `fileId` selects which — omitted, it is ' +
          "the project's first text file.\n\n" +
          'Slices belonging to a project checkpoint are excluded; they are not ' +
          'free-standing history. Listing also sweeps auto-open checkpoints ' +
          'older than 30 days.',
        params: DocIdParams,
        querystring: z.object({ fileId: z.uuid().optional() }),
        response: {
          200: z.object({ checkpoints: z.array(Checkpoint) }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        checkpoints: await listCheckpoints(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.query.fileId ?? null,
          (err) => request.log.warn({ err }, 'auto-open checkpoint retention sweep failed'),
        ),
      });
    },
  );

  v1.post(
    '/docs/:id/checkpoints',
    {
      schema: {
        tags: ['checkpoints'],
        summary: 'Take a checkpoint of one file',
        description:
          "Snapshots the file's current content under a label. Take one before " +
          'a scripted bulk edit and you have a way back.',
        params: DocIdParams,
        querystring: z.object({ fileId: z.uuid().optional() }),
        body: z.object({ label: z.string().min(1).max(120) }),
        response: {
          201: z
            .object({
              checkpoint: z.object({
                id: z.uuid(),
                label: z.string(),
                kind: z.string(),
                file_path: z.string(),
                created_at: z.string(),
              }),
            })
            .meta({ id: 'CreatedCheckpoint' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...archived,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const result = await createCheckpoint(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        { label: request.body.label, auto: false, fileId: request.query.fileId ?? null },
      );
      // `auto` is not exposed on this plane, so a coalesced result cannot
      // occur here — but narrow rather than cast.
      if ('skipped' in result) throw new Error('unexpected coalesced checkpoint');
      return reply.status(201).send({ checkpoint: result });
    },
  );

  v1.get(
    '/docs/:id/checkpoints/:checkpointId',
    {
      schema: {
        tags: ['checkpoints'],
        summary: 'Get one checkpoint',
        params: CheckpointParams,
        response: {
          200: z
            .object({
              checkpoint: z.object({
                id: z.uuid(),
                label: z.string(),
                file_path: z.string(),
                created_by: z.uuid().nullable(),
                created_at: z.string(),
                download_url: z.string(),
              }),
            })
            .meta({ id: 'CheckpointDetail' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        checkpoint: await getCheckpoint(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.params.checkpointId,
        ),
      });
    },
  );

  v1.get(
    '/docs/:id/checkpoints/:checkpointId/download',
    {
      schema: {
        tags: ['checkpoints'],
        summary: "Download a checkpoint's raw CRDT snapshot",
        description:
          'The encoded Yjs update, as `application/octet-stream`. Useful for an ' +
          'external archive; to get readable text, restore it and read the ' +
          "file's content instead.",
        params: CheckpointParams,
        response: {
          200: z.any().describe('The encoded Yjs snapshot.'),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const obj = await openCheckpoint(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.params.checkpointId,
      );
      reply.header('content-type', 'application/octet-stream');
      if (obj.contentLength != null) reply.header('content-length', obj.contentLength);
      return reply.send(obj.body);
    },
  );

  v1.post(
    '/docs/:id/checkpoints/:checkpointId/restore',
    {
      schema: {
        tags: ['checkpoints'],
        summary: 'Restore one file to a checkpoint',
        description:
          'Applies the snapshot as a CRDT transaction against the live document ' +
          'and tells any open editor to re-bootstrap — so this converges with a ' +
          'collaborator rather than fighting them. The restore is itself a new ' +
          'revision, so it can be undone by restoring a later checkpoint.',
        params: CheckpointParams,
        response: {
          200: z
            .object({ restored: z.literal(true), rev: z.string(), file_path: z.string() })
            .meta({ id: 'CheckpointRestored' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...archived,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(
        await restoreCheckpoint(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.params.checkpointId,
          (err) => request.log.warn({ err }, 'room_evict NOTIFY failed after checkpoint restore'),
        ),
      );
    },
  );

  v1.get(
    '/docs/:id/project-checkpoints',
    {
      schema: {
        tags: ['checkpoints'],
        summary: 'List whole-project checkpoints',
        params: DocIdParams,
        response: {
          200: z.object({
            project_checkpoints: z.array(
              z
                .object({
                  id: z.uuid(),
                  label: z.string(),
                  created_by: z.uuid().nullable(),
                  created_at: z.string(),
                  file_count: z.number(),
                  blob_count: z.number(),
                })
                .meta({ id: 'ProjectCheckpoint' }),
            ),
          }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        project_checkpoints: await listProjectCheckpoints(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
        ),
      });
    },
  );

  v1.post(
    '/docs/:id/project-checkpoints',
    {
      // Snapshots every text file to the blob store.
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        tags: ['checkpoints'],
        summary: 'Take a checkpoint of the whole project',
        description:
          'Snapshots **every** text file and pins the current blob set under one ' +
          'label — the thing to do before a scripted change that touches more ' +
          'than one file.\n\n' +
          'Rate limited to **6 per minute per token**.',
        params: DocIdParams,
        body: z.object({ label: z.string().min(1).max(120) }),
        response: {
          201: z
            .object({
              project_checkpoint: z.object({
                id: z.uuid(),
                label: z.string(),
                created_at: z.string(),
                files: z.array(z.object({ file_id: z.uuid(), path: z.string() })),
                blobs: z.array(z.object({ path: z.string() })),
              }),
            })
            .meta({ id: 'CreatedProjectCheckpoint' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...archived,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const project_checkpoint = await createProjectCheckpoint(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.body,
      );
      return reply.status(201).send({ project_checkpoint });
    },
  );

  v1.post(
    '/docs/:id/project-checkpoints/:projectCheckpointId/restore',
    {
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        tags: ['checkpoints'],
        summary: 'Restore the whole project to a checkpoint',
        description:
          'Restores every captured text file and replaces the blob set wholesale.\n\n' +
          '`blobs_missing` names any pinned object whose bytes have since gone — ' +
          'the restore still completes for everything else rather than failing ' +
          'outright, and tells you what did not come back.',
        params: ProjectParams,
        response: {
          200: z
            .object({
              restored: z.literal(true),
              files_restored: z.number(),
              files: z.array(z.object({ path: z.string(), rev: z.string() })),
              blobs_restored: z.number(),
              blobs_missing: z.array(z.string()),
              blob_state_preserved: z.literal(true),
            })
            .meta({ id: 'ProjectCheckpointRestored' }),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...archived,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(
        await restoreProjectCheckpoint(
          serviceContext(app, request, actor),
          actor,
          request.params.id,
          request.params.projectCheckpointId,
          (err, yjsDocId) =>
            request.log.warn(
              { err, yjsDocId },
              'room_evict NOTIFY failed after project-checkpoint restore',
            ),
        ),
      );
    },
  );

  v1.delete(
    '/docs/:id/project-checkpoints/:projectCheckpointId',
    {
      schema: {
        tags: ['checkpoints'],
        summary: 'Delete a project checkpoint',
        description:
          'Removes the checkpoint and its file slices. The pinned S3 objects are ' +
          'not deleted here — the file-delete path is what frees bytes once ' +
          'nothing references them.',
        params: ProjectParams,
        response: {
          204: z.null(),
          ...errorResponses(),
          ...forbidden,
          ...notFound,
          ...archived,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      await deleteProjectCheckpoint(
        serviceContext(app, request, actor),
        actor,
        request.params.id,
        request.params.projectCheckpointId,
      );
      return reply.status(204).send(null);
    },
  );
}
