import crypto from 'node:crypto';
import type { Readable } from 'node:stream';

import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import * as Y from 'yjs';

import { loadDoc, persistUpdate, type BlobStore, type CrdtDeps } from '@aeolus/crdt';
import {
  docCheckpoints,
  docFiles,
  docProjectCheckpointBlobs,
  docProjectCheckpoints,
  users,
  type Database,
} from '@aeolus/db';

import type { Actor } from '../actor.js';
import { assertCanRead, assertCanWrite } from '../acl.js';
import type { ServiceContext } from './context.js';
import { NotFoundError } from './errors.js';
import { evictRoom } from './room-evict.js';

/**
 * Version history: per-file checkpoints, and whole-project checkpoints.
 *
 * Both key on `yjs_doc_id` rather than `docs.id` — per ADR 0013 each text file
 * carries its own CRDT — which is why every operation here starts by
 * translating a (docId, fileId?) pair into one.
 */

/** Repeat opens inside this window do not re-snapshot. */
const AUTO_OPEN_COALESCE_MINUTES = 5;
/** Auto-open checkpoints expire after this, swept on list (as ADR 0015 does). */
const AUTO_OPEN_RETENTION_DAYS = 30;

export interface CheckpointView {
  id: string;
  label: string;
  kind: string;
  file_path: string;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
}

export interface ProjectCheckpointView {
  id: string;
  label: string;
  created_by: string | null;
  created_at: string;
  file_count: number;
  blob_count: number;
}

export class NoTextFileError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
  constructor() {
    super('No text file to checkpoint');
  }
}

/**
 * Resolve a (docId, optional fileId) to the file's `yjs_doc_id`.
 *
 * With no fileId this picks the project's first text file — back-compat for
 * callers written before per-file checkpoints existed.
 */
async function resolveFile(
  db: Database,
  docId: string,
  fileId: string | null,
): Promise<{ yjsDocId: string; filePath: string } | null> {
  const where = fileId
    ? and(eq(docFiles.id, fileId), eq(docFiles.docId, docId), eq(docFiles.kind, 'text'))
    : and(eq(docFiles.docId, docId), eq(docFiles.kind, 'text'));
  const q = db
    .select({ yjsDocId: docFiles.yjsDocId, path: docFiles.path })
    .from(docFiles)
    .where(where);
  const [row] = fileId ? await q.limit(1) : await q.orderBy(docFiles.createdAt).limit(1);
  return row?.yjsDocId ? { yjsDocId: row.yjsDocId, filePath: row.path } : null;
}

interface ResolvedCheckpoint {
  id: string;
  yjsDocId: string;
  snapshotKey: string;
  filePath: string;
  label: string;
  createdBy: string | null;
  createdAt: Date;
}

/**
 * A checkpoint, verified to belong to a file in this document.
 *
 * Joins through `doc_files` on `yjs_doc_id` so the doc → file → checkpoint
 * chain is bounded by FK semantics rather than by comparing against the main
 * file's id, which silently 404'd every per-file checkpoint.
 */
async function findCheckpoint(
  db: Database,
  docId: string,
  checkpointId: string,
): Promise<ResolvedCheckpoint | null> {
  const [row] = await db
    .select({
      id: docCheckpoints.id,
      yjsDocId: docCheckpoints.yjsDocId,
      snapshotKey: docCheckpoints.snapshotKey,
      label: docCheckpoints.label,
      createdBy: docCheckpoints.createdBy,
      createdAt: docCheckpoints.createdAt,
      filePath: docFiles.path,
      fileDocId: docFiles.docId,
    })
    .from(docCheckpoints)
    .innerJoin(docFiles, eq(docFiles.yjsDocId, docCheckpoints.yjsDocId))
    .where(eq(docCheckpoints.id, checkpointId))
    .limit(1);
  if (!row || row.fileDocId !== docId) return null;
  return {
    id: row.id,
    yjsDocId: row.yjsDocId,
    snapshotKey: row.snapshotKey,
    filePath: row.filePath,
    label: row.label,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Retention sweep for auto-open checkpoints, run as a side effect of listing
 * so retention needs no scheduler — the same pattern as `audit_events`.
 * User-named checkpoints are never touched.
 */
async function pruneOldAutoOpen(db: Database, blobs: BlobStore): Promise<void> {
  const cutoff = sql`now() - interval '${sql.raw(String(AUTO_OPEN_RETENTION_DAYS))} days'`;
  const expired = await db
    .select({ id: docCheckpoints.id, snapshotKey: docCheckpoints.snapshotKey })
    .from(docCheckpoints)
    .where(and(eq(docCheckpoints.kind, 'auto_open'), sql`${docCheckpoints.createdAt} < ${cutoff}`))
    .limit(500);
  if (expired.length === 0) return;
  await Promise.all(
    expired.map(async (row) => {
      try {
        await blobs.delete(row.snapshotKey);
      } catch {
        // One bad key must not block the sweep. Anything left is an orphan the
        // admin blob-gc pass picks up later.
      }
    }),
  );
  await db
    .delete(docCheckpoints)
    .where(and(eq(docCheckpoints.kind, 'auto_open'), sql`${docCheckpoints.createdAt} < ${cutoff}`));
}

/** Snapshot one file's CRDT to the blob store, returning its key. */
async function snapshotFile(ctx: ServiceContext, yjsDocId: string, key: string): Promise<void> {
  const crdt: CrdtDeps = { db: ctx.db, blobs: ctx.blobs };
  const loaded = await loadDoc(crdt, yjsDocId);
  const encoded = Y.encodeStateAsUpdate(loaded.doc);
  loaded.doc.destroy();
  await ctx.blobs.put(key, Buffer.from(encoded));
}

/**
 * Apply a stored snapshot's text into the live CRDT.
 *
 * A transaction against the live document rather than a replacement, so a
 * collaborator with the file open converges instead of desynchronising — the
 * same mechanic `writeTextFile` uses. Returns the sequence written.
 */
async function restoreSnapshotInto(
  ctx: ServiceContext,
  actor: Actor,
  yjsDocId: string,
  snapshotBytes: Buffer,
): Promise<bigint> {
  const crdt: CrdtDeps = { db: ctx.db, blobs: ctx.blobs };

  const snapshotDoc = new Y.Doc();
  Y.applyUpdate(snapshotDoc, new Uint8Array(snapshotBytes));
  const targetText = snapshotDoc.getText('source').toString();
  snapshotDoc.destroy();

  const loaded = await loadDoc(crdt, yjsDocId);
  const liveDoc = loaded.doc;
  try {
    const beforeSv = Y.encodeStateVector(liveDoc);
    const liveText = liveDoc.getText('source');
    liveDoc.transact(() => {
      liveText.delete(0, liveText.length);
      liveText.insert(0, targetText);
    });
    const update = Y.encodeStateAsUpdate(liveDoc, beforeSv);
    await persistUpdate(crdt, yjsDocId, loaded.nextSeq, update, actor.id);
    return loaded.nextSeq;
  } finally {
    liveDoc.destroy();
  }
}

export interface CreatedCheckpoint {
  id: string;
  label: string;
  kind: string;
  file_path: string;
  created_at: string;
}

export async function createCheckpoint(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  input: { label?: string; auto?: boolean; fileId?: string | null },
): Promise<CreatedCheckpoint | { skipped: true; reason: 'coalesced' }> {
  await assertCanWrite(ctx.acl, actor.id, docId);
  const target = await resolveFile(ctx.db, docId, input.fileId ?? null);
  if (!target) throw new NoTextFileError();

  const auto = input.auto === true;
  if (auto) {
    // Opening a file twice in quick succession must not double-snapshot.
    const cutoff = sql`now() - interval '${sql.raw(String(AUTO_OPEN_COALESCE_MINUTES))} minutes'`;
    const [recent] = await ctx.db
      .select({ id: docCheckpoints.id })
      .from(docCheckpoints)
      .where(
        and(
          eq(docCheckpoints.yjsDocId, target.yjsDocId),
          eq(docCheckpoints.kind, 'auto_open'),
          eq(docCheckpoints.createdBy, actor.id),
          gt(docCheckpoints.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (recent) return { skipped: true, reason: 'coalesced' };
  }

  const checkpointId = crypto.randomUUID();
  const snapshotKey = `checkpoints/${docId}/${checkpointId}.ydoc`;
  await snapshotFile(ctx, target.yjsDocId, snapshotKey);

  const label = auto ? `Opened by ${actor.email}` : (input.label as string);
  const [row] = await ctx.db
    .insert(docCheckpoints)
    .values({
      id: checkpointId,
      yjsDocId: target.yjsDocId,
      label,
      snapshotKey,
      createdBy: actor.id,
      kind: auto ? 'auto_open' : 'user',
    })
    .returning({
      id: docCheckpoints.id,
      label: docCheckpoints.label,
      kind: docCheckpoints.kind,
      createdAt: docCheckpoints.createdAt,
    });

  // Only user-named checkpoints are audited. An auto-open fires on every
  // editor mount, and burying real events under that noise would make the
  // trail useless.
  if (!auto) {
    await ctx.audit({
      action: 'checkpoint.create',
      resourceType: 'doc_checkpoint',
      resourceId: row.id,
      metadata: { doc_id: docId, label, file_path: target.filePath },
    });
  }

  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    file_path: target.filePath,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listCheckpoints(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  fileId: string | null,
  onSweepError?: (err: unknown) => void,
): Promise<CheckpointView[]> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const target = await resolveFile(ctx.db, docId, fileId);
  if (!target) return [];

  await pruneOldAutoOpen(ctx.db, ctx.blobs).catch((err) => onSweepError?.(err));

  const rows = await ctx.db
    .select({
      id: docCheckpoints.id,
      label: docCheckpoints.label,
      kind: docCheckpoints.kind,
      createdBy: docCheckpoints.createdBy,
      createdAt: docCheckpoints.createdAt,
      creatorEmail: users.email,
    })
    .from(docCheckpoints)
    .leftJoin(users, eq(docCheckpoints.createdBy, users.id))
    .where(
      and(
        eq(docCheckpoints.yjsDocId, target.yjsDocId),
        // Slices of a project checkpoint are not free-standing history.
        isNull(docCheckpoints.projectCheckpointId),
      ),
    )
    .orderBy(desc(docCheckpoints.createdAt));

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    file_path: target.filePath,
    created_by: r.createdBy,
    created_by_email: r.creatorEmail,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getCheckpoint(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  checkpointId: string,
): Promise<{
  id: string;
  label: string;
  file_path: string;
  created_by: string | null;
  created_at: string;
  download_url: string;
}> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const row = await findCheckpoint(ctx.db, docId, checkpointId);
  if (!row) throw new NotFoundError('Checkpoint');
  return {
    id: row.id,
    label: row.label,
    file_path: row.filePath,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    download_url: `/docs/${docId}/checkpoints/${row.id}/download`,
  };
}

export async function openCheckpoint(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  checkpointId: string,
): Promise<{ body: Readable; contentLength: number | null }> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const row = await findCheckpoint(ctx.db, docId, checkpointId);
  if (!row) throw new NotFoundError('Checkpoint');
  const obj = await ctx.blobs.getStream(row.snapshotKey);
  if (!obj) throw new NotFoundError('Checkpoint');
  return { body: obj.body as Readable, contentLength: obj.contentLength ?? null };
}

export async function restoreCheckpoint(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  checkpointId: string,
  onEvictError?: (err: unknown) => void,
): Promise<{ restored: true; rev: string; file_path: string }> {
  await assertCanWrite(ctx.acl, actor.id, docId);
  const row = await findCheckpoint(ctx.db, docId, checkpointId);
  if (!row) throw new NotFoundError('Checkpoint');

  const snapshotBytes = await ctx.blobs.get(row.snapshotKey);
  if (!snapshotBytes) throw new NotFoundError('Checkpoint');

  const seq = await restoreSnapshotInto(ctx, actor, row.yjsDocId, snapshotBytes);
  await evictRoom(ctx.db, row.yjsDocId, onEvictError);
  await ctx.audit({
    action: 'checkpoint.restore',
    resourceType: 'doc_checkpoint',
    resourceId: row.id,
    metadata: { doc_id: docId, file_path: row.filePath, rev: seq.toString() },
  });

  return { restored: true, rev: seq.toString(), file_path: row.filePath };
}

export interface CreatedProjectCheckpoint {
  id: string;
  label: string;
  created_at: string;
  files: Array<{ file_id: string; path: string }>;
  blobs: Array<{ path: string }>;
}

/** Snapshot every text file AND pin the current blob set, under one label. */
export async function createProjectCheckpoint(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  input: { label: string },
): Promise<CreatedProjectCheckpoint> {
  await assertCanWrite(ctx.acl, actor.id, docId);

  const textFiles = await ctx.db
    .select({ fileId: docFiles.id, path: docFiles.path, yjsDocId: docFiles.yjsDocId })
    .from(docFiles)
    .where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'text')));
  if (textFiles.length === 0) throw new NoTextFileError();

  const blobFiles = await ctx.db
    .select({
      path: docFiles.path,
      storageKey: docFiles.storageKey,
      filename: docFiles.filename,
      mimeType: docFiles.mimeType,
      sizeBytes: docFiles.sizeBytes,
      uploadedBy: docFiles.uploadedBy,
    })
    .from(docFiles)
    .where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'blob')));

  const projectCheckpointId = crypto.randomUUID();
  const fileSnapshots: Array<{
    fileId: string;
    path: string;
    yjsDocId: string;
    checkpointId: string;
    snapshotKey: string;
  }> = [];

  // Snapshots go to the blob store before the transaction, so the transaction
  // stays short.
  for (const file of textFiles) {
    if (!file.yjsDocId) continue;
    const checkpointId = crypto.randomUUID();
    const snapshotKey = `checkpoints/${docId}/${projectCheckpointId}/${checkpointId}.ydoc`;
    await snapshotFile(ctx, file.yjsDocId, snapshotKey);
    fileSnapshots.push({
      fileId: file.fileId,
      path: file.path,
      yjsDocId: file.yjsDocId,
      checkpointId,
      snapshotKey,
    });
  }

  const survivingBlobs = blobFiles.filter((b) => b.storageKey != null);

  const created = await ctx.db.transaction(async (tx) => {
    const [project] = await tx
      .insert(docProjectCheckpoints)
      .values({ id: projectCheckpointId, docId, label: input.label, createdBy: actor.id })
      .returning({
        id: docProjectCheckpoints.id,
        label: docProjectCheckpoints.label,
        createdAt: docProjectCheckpoints.createdAt,
      });
    if (fileSnapshots.length > 0) {
      await tx.insert(docCheckpoints).values(
        fileSnapshots.map((s) => ({
          id: s.checkpointId,
          yjsDocId: s.yjsDocId,
          label: input.label,
          snapshotKey: s.snapshotKey,
          createdBy: actor.id,
          projectCheckpointId,
        })),
      );
    }
    if (survivingBlobs.length > 0) {
      await tx.insert(docProjectCheckpointBlobs).values(
        survivingBlobs.map((b) => ({
          projectCheckpointId,
          path: b.path,
          storageKey: b.storageKey!,
          filename: b.filename,
          mimeType: b.mimeType,
          sizeBytes: b.sizeBytes,
          uploadedBy: b.uploadedBy,
        })),
      );
    }
    return project;
  });

  await ctx.audit({
    action: 'project_checkpoint.create',
    resourceType: 'doc_project_checkpoint',
    resourceId: created.id,
    metadata: {
      doc_id: docId,
      label: input.label,
      files: fileSnapshots.length,
      blobs: survivingBlobs.length,
    },
  });

  return {
    id: created.id,
    label: created.label,
    created_at: created.createdAt.toISOString(),
    files: fileSnapshots.map((s) => ({ file_id: s.fileId, path: s.path })),
    blobs: survivingBlobs.map((b) => ({ path: b.path })),
  };
}

export async function listProjectCheckpoints(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
): Promise<ProjectCheckpointView[]> {
  await assertCanRead(ctx.acl, actor.id, docId);

  const fileCounts = ctx.db
    .select({
      projectId: docCheckpoints.projectCheckpointId,
      cnt: count(docCheckpoints.id).as('file_count'),
    })
    .from(docCheckpoints)
    .groupBy(docCheckpoints.projectCheckpointId)
    .as('cp_file_counts');
  const blobCounts = ctx.db
    .select({
      projectId: docProjectCheckpointBlobs.projectCheckpointId,
      cnt: count(docProjectCheckpointBlobs.id).as('blob_count'),
    })
    .from(docProjectCheckpointBlobs)
    .groupBy(docProjectCheckpointBlobs.projectCheckpointId)
    .as('cp_blob_counts');

  const rows = await ctx.db
    .select({
      id: docProjectCheckpoints.id,
      label: docProjectCheckpoints.label,
      createdBy: docProjectCheckpoints.createdBy,
      createdAt: docProjectCheckpoints.createdAt,
      fileCount: fileCounts.cnt,
      blobCount: blobCounts.cnt,
    })
    .from(docProjectCheckpoints)
    .leftJoin(fileCounts, eq(fileCounts.projectId, docProjectCheckpoints.id))
    .leftJoin(blobCounts, eq(blobCounts.projectId, docProjectCheckpoints.id))
    .where(eq(docProjectCheckpoints.docId, docId))
    .orderBy(desc(docProjectCheckpoints.createdAt));

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
    file_count: Number(r.fileCount ?? 0),
    blob_count: Number(r.blobCount ?? 0),
  }));
}

export interface ProjectRestoreResult {
  restored: true;
  files_restored: number;
  files: Array<{ path: string; rev: string }>;
  blobs_restored: number;
  blobs_missing: string[];
  blob_state_preserved: true;
}

export async function restoreProjectCheckpoint(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  projectCheckpointId: string,
  onEvictError?: (err: unknown, yjsDocId: string) => void,
): Promise<ProjectRestoreResult> {
  await assertCanWrite(ctx.acl, actor.id, docId);

  const [project] = await ctx.db
    .select({ id: docProjectCheckpoints.id, docId: docProjectCheckpoints.docId })
    .from(docProjectCheckpoints)
    .where(eq(docProjectCheckpoints.id, projectCheckpointId))
    .limit(1);
  if (!project || project.docId !== docId) throw new NotFoundError('Project checkpoint');

  const slices = await ctx.db
    .select({
      yjsDocId: docCheckpoints.yjsDocId,
      snapshotKey: docCheckpoints.snapshotKey,
      path: docFiles.path,
    })
    .from(docCheckpoints)
    .innerJoin(docFiles, eq(docFiles.yjsDocId, docCheckpoints.yjsDocId))
    .where(
      and(eq(docCheckpoints.projectCheckpointId, projectCheckpointId), eq(docFiles.docId, docId)),
    );

  const restored: Array<{ path: string; rev: string }> = [];
  for (const slice of slices) {
    const snapshotBytes = await ctx.blobs.get(slice.snapshotKey);
    // A slice whose blob has gone is skipped rather than failing the whole
    // restore: the other files are still recoverable, and the caller is told
    // how many landed.
    if (!snapshotBytes) continue;
    const seq = await restoreSnapshotInto(ctx, actor, slice.yjsDocId, snapshotBytes);
    restored.push({ path: slice.path, rev: seq.toString() });
    await evictRoom(ctx.db, slice.yjsDocId, (err) => onEvictError?.(err, slice.yjsDocId));
  }

  const pinned = await ctx.db
    .select({
      path: docProjectCheckpointBlobs.path,
      storageKey: docProjectCheckpointBlobs.storageKey,
      filename: docProjectCheckpointBlobs.filename,
      mimeType: docProjectCheckpointBlobs.mimeType,
      sizeBytes: docProjectCheckpointBlobs.sizeBytes,
      uploadedBy: docProjectCheckpointBlobs.uploadedBy,
    })
    .from(docProjectCheckpointBlobs)
    .where(eq(docProjectCheckpointBlobs.projectCheckpointId, projectCheckpointId));

  // Which pinned objects still exist. A checkpoint can outlive its bytes, and
  // the caller needs to know which ones rather than silently getting fewer.
  const presence = await Promise.all(
    pinned.map(async (b) => ({ blob: b, exists: (await ctx.blobs.get(b.storageKey)) != null })),
  );
  const survived = presence.filter((p) => p.exists).map((p) => p.blob);
  const blobsMissing = presence.filter((p) => !p.exists).map((p) => p.blob.path);

  // Replace the blob set wholesale, in one transaction, so a failure mid-way
  // cannot leave a half-shaped project. The S3 objects are not deleted here —
  // the file-delete path skips the S3 delete for any key a project checkpoint
  // still pins.
  await ctx.db.transaction(async (tx) => {
    await tx.delete(docFiles).where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'blob')));
    if (survived.length > 0) {
      await tx.insert(docFiles).values(
        survived.map((b) => ({
          docId,
          path: b.path,
          kind: 'blob' as const,
          storageKey: b.storageKey,
          filename: b.filename,
          mimeType: b.mimeType,
          sizeBytes: b.sizeBytes,
          uploadedBy: b.uploadedBy,
        })),
      );
    }
  });

  await ctx.audit({
    action: 'project_checkpoint.restore',
    resourceType: 'doc_project_checkpoint',
    resourceId: projectCheckpointId,
    metadata: {
      doc_id: docId,
      files_restored: restored.length,
      blobs_restored: survived.length,
      blobs_missing: blobsMissing.length,
    },
  });

  return {
    restored: true,
    files_restored: restored.length,
    files: restored,
    blobs_restored: survived.length,
    blobs_missing: blobsMissing,
    blob_state_preserved: true,
  };
}

export async function deleteProjectCheckpoint(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  projectCheckpointId: string,
): Promise<void> {
  await assertCanWrite(ctx.acl, actor.id, docId);
  const result = await ctx.db
    .delete(docProjectCheckpoints)
    .where(
      and(
        eq(docProjectCheckpoints.id, projectCheckpointId),
        eq(docProjectCheckpoints.docId, docId),
      ),
    )
    .returning({ id: docProjectCheckpoints.id });
  if (result.length === 0) throw new NotFoundError('Project checkpoint');
  await ctx.audit({
    action: 'project_checkpoint.delete',
    resourceType: 'doc_project_checkpoint',
    resourceId: projectCheckpointId,
    metadata: { doc_id: docId },
  });
}
