import crypto from 'node:crypto';
import path from 'node:path';

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import * as Y from 'yjs';

import { loadDoc, persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { docFiles, docProjectCheckpointBlobs, docSnapshots, docUpdates } from '@aeolus/db';

import type { Actor } from '../actor.js';
import { assertCanRead, assertCanWrite, DocNotFoundError } from '../acl.js';
import { touchProject } from '../project-touch.js';
import { evictRoom } from './room-evict.js';
import type { ServiceContext } from './context.js';
import {
  EXT_TO_MIME,
  MAX_SINGLE_BYTES,
  MAX_TOTAL_BYTES,
  isMainEntrypoint,
  isUniqueViolation,
  uniqueDocFilesPath,
  validatePath,
} from './file-paths.js';

/**
 * A project's file tree — text files, uploaded blobs, and folders.
 *
 * One implementation behind three surfaces: the browser plane's `/files`
 * (path-aware) and `/assets` (bare-filename, auto-deduping) routes, and
 * `/api/v1`. Collapsing `/assets` onto this is issue #9 phase 4.
 */

export type FileKind = 'text' | 'blob' | 'folder';

export interface FileView {
  id: string;
  path: string;
  kind: FileKind;
  yjs_doc_id: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
  updated_at: string;
}

export class PathTakenError extends Error {
  readonly statusCode = 409;
  readonly code = 'path_taken';
  constructor() {
    super('A file or folder already exists at that path');
  }
}

export class InvalidPathError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_path';
}

export class MainFileLockedError extends Error {
  readonly statusCode = 422;
  readonly code = 'main_file_locked';
  constructor(verb: string) {
    super(`The main entrypoint cannot be ${verb}`);
  }
}

export class FolderNotEmptyError extends Error {
  readonly statusCode = 422;
  readonly code = 'folder_not_empty';
  /**
   * Extra fields to merge into the error body. `children` is part of the
   * contract — the UI shows "3 items inside" — so it has to survive the trip
   * through the error handler, which otherwise emits only { error, message }.
   */
  readonly payload: { children: number };
  constructor(children: number) {
    super(`Folder is not empty (${children} item${children === 1 ? '' : 's'} inside).`);
    this.payload = { children };
  }
}

export class UnsupportedTypeError extends Error {
  readonly statusCode = 400;
  readonly code = 'unsupported_type';
  constructor(ext: string) {
    super(`File type ${ext || 'unknown'} is not allowed`);
  }
}

export class FileTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = 'file_too_large';
  constructor() {
    super(`File exceeds ${MAX_SINGLE_BYTES / 1024 / 1024}MB limit`);
  }
}

export class QuotaExceededError extends Error {
  readonly statusCode = 413;
  readonly code = 'quota_exceeded';
  constructor() {
    super(`Total assets would exceed ${MAX_TOTAL_BYTES / 1024 / 1024}MB per-document limit`);
  }
}

export class FileNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
  constructor(what = 'File') {
    super(`${what} not found`);
  }
}

function asKind(v: string): FileKind {
  return v === 'blob' ? 'blob' : v === 'folder' ? 'folder' : 'text';
}

/**
 * Encoded byte size for every text file, in two round trips rather than one
 * per row. Steady state: one `doc_snapshots` row per yjs doc plus a tail of
 * post-snapshot `doc_updates`. `snapshots.bytes` was added later, so
 * pre-0022 rows read NULL until the next compaction backfills them — coalesced
 * to 0 rather than reported as unknown.
 */
async function textSizes(ctx: ServiceContext, yjsIds: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (yjsIds.length === 0) return sizes;

  const snapshotRows = await ctx.db
    .select({ yjsDocId: docSnapshots.yjsDocId, bytes: docSnapshots.bytes })
    .from(docSnapshots)
    .where(inArray(docSnapshots.yjsDocId, yjsIds));
  const tailRows = await ctx.db
    .select({
      yjsDocId: docUpdates.yjsDocId,
      tailBytes: sql<string>`COALESCE(SUM(octet_length(${docUpdates.update})), 0)`,
    })
    .from(docUpdates)
    .where(inArray(docUpdates.yjsDocId, yjsIds))
    .groupBy(docUpdates.yjsDocId);

  const snapshotByYjs = new Map(snapshotRows.map((r) => [r.yjsDocId, r.bytes ?? 0]));
  const tailByYjs = new Map(tailRows.map((r) => [r.yjsDocId, parseInt(r.tailBytes, 10)]));
  for (const id of yjsIds) {
    sizes.set(id, (snapshotByYjs.get(id) ?? 0) + (tailByYjs.get(id) ?? 0));
  }
  return sizes;
}

export async function listFiles(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
): Promise<FileView[]> {
  await assertCanRead(ctx.acl, actor.id, docId);

  const rows = await ctx.db
    .select({
      id: docFiles.id,
      path: docFiles.path,
      kind: docFiles.kind,
      yjsDocId: docFiles.yjsDocId,
      sizeBytes: docFiles.sizeBytes,
      mimeType: docFiles.mimeType,
      createdAt: docFiles.createdAt,
      updatedAt: docFiles.updatedAt,
    })
    .from(docFiles)
    .where(eq(docFiles.docId, docId))
    .orderBy(docFiles.path);

  const sizes = await textSizes(
    ctx,
    rows.filter((r) => r.kind === 'text' && r.yjsDocId !== null).map((r) => r.yjsDocId as string),
  );

  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    kind: asKind(r.kind),
    yjs_doc_id: r.yjsDocId,
    size_bytes: r.kind === 'text' ? (r.yjsDocId ? (sizes.get(r.yjsDocId) ?? 0) : 0) : r.sizeBytes,
    mime_type: r.mimeType,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }));
}

/** Blobs only, in the shape the older `/assets` surface returns. */
export interface AssetView {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export async function listAssets(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
): Promise<AssetView[]> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const rows = await ctx.db
    .select({
      id: docFiles.id,
      filename: docFiles.filename,
      mimeType: docFiles.mimeType,
      sizeBytes: docFiles.sizeBytes,
      createdAt: docFiles.createdAt,
    })
    .from(docFiles)
    .where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'blob')))
    .orderBy(docFiles.createdAt);
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename ?? '',
    mime_type: r.mimeType ?? 'application/octet-stream',
    size_bytes: r.sizeBytes ?? 0,
    created_at: r.createdAt.toISOString(),
  }));
}

/**
 * A write to the file tree needs the doc writable AND not soft-deleted.
 * `assertCanWrite` covers the first; the `deletedAt` check is the second, and
 * it matters because an admin resolves to owner even on a deleted doc.
 */
async function assertWritableProject(ctx: ServiceContext, actor: Actor, docId: string) {
  const doc = await assertCanWrite(ctx.acl, actor.id, docId);
  if (doc.deletedAt !== null) throw new DocNotFoundError();
  return doc;
}

export interface CreatedFile {
  id: string;
  path: string;
  kind: FileKind;
  yjs_doc_id: string | null;
  created_at: string;
}

export async function createFile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  input: { path: string; kind?: 'text' | 'folder' },
): Promise<CreatedFile> {
  await assertWritableProject(ctx, actor, docId);

  const v = validatePath(input.path);
  if ('error' in v) throw new InvalidPathError(v.error);

  const kind = input.kind ?? 'text';
  // A folder carries no yjs doc and no storage key; the kind/payload CHECK
  // on doc_files enforces that on the database side too.
  const yjsDocId = kind === 'folder' ? null : crypto.randomUUID();

  try {
    const [row] = await ctx.db
      .insert(docFiles)
      .values({ docId, path: v.path, kind, ...(yjsDocId ? { yjsDocId } : {}) })
      .returning({ id: docFiles.id, path: docFiles.path, createdAt: docFiles.createdAt });
    await touchProject(ctx.db, docId);
    await ctx.audit({
      action: 'file.create',
      resourceType: 'doc_file',
      resourceId: row.id,
      metadata: { doc_id: docId, path: row.path, kind },
    });
    return {
      id: row.id,
      path: row.path,
      kind,
      yjs_doc_id: yjsDocId,
      created_at: row.createdAt.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) throw new PathTakenError();
    throw err;
  }
}

export interface UploadedFile extends CreatedFile {
  mime_type: string;
  size_bytes: number;
  filename: string;
}

/**
 * Store an uploaded blob.
 *
 * `dedupePath` picks between the two historical behaviours: the `/files`
 * surface 409s on a taken path, while the bare-filename `/assets` surface
 * appends `-2`. Both are legitimate; making it a parameter is what let the two
 * routes collapse onto one implementation.
 */
export class MissingFileError extends Error {
  readonly statusCode = 400;
  readonly code = 'missing_file';
  constructor() {
    super('No file uploaded');
  }
}

export async function uploadFile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  input: {
    /**
     * Deferred on purpose. Authorization has to happen BEFORE the multipart
     * stream is touched: draining first means an unauthorized caller — or one
     * writing to an archived document — gets whatever the multipart parser
     * says about their request instead of the 403/404/422 the contract
     * promises. (Reversing this turned an archived-document upload from 422
     * into a 406 "not multipart", which is how it was caught.)
     */
    read: () => Promise<{ rawPath: string; body: Buffer } | null>;
    dedupePath?: boolean;
  },
): Promise<UploadedFile> {
  await assertWritableProject(ctx, actor, docId);

  const upload = await input.read();
  if (!upload) throw new MissingFileError();

  const v = validatePath(upload.rawPath);
  if ('error' in v) throw new InvalidPathError(v.error);
  const filename = path.posix.basename(v.path);

  const ext = path.extname(filename).toLowerCase();
  const mimeFromExt = EXT_TO_MIME[ext];
  if (!mimeFromExt) throw new UnsupportedTypeError(ext);
  if (upload.body.length > MAX_SINGLE_BYTES) throw new FileTooLargeError();

  const [{ total }] = await ctx.db
    .select({ total: sql<number>`coalesce(sum(${docFiles.sizeBytes}), 0)::int` })
    .from(docFiles)
    .where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'blob')));
  if (total + upload.body.length > MAX_TOTAL_BYTES) throw new QuotaExceededError();

  const storageKey = `assets/${docId}/${crypto.randomUUID()}${ext}`;
  await ctx.blobs.put(storageKey, upload.body);

  const targetPath = input.dedupePath ? await uniqueDocFilesPath(ctx.db, docId, filename) : v.path;

  try {
    const [row] = await ctx.db
      .insert(docFiles)
      .values({
        docId,
        path: targetPath,
        kind: 'blob',
        storageKey,
        filename,
        mimeType: mimeFromExt,
        sizeBytes: upload.body.length,
        uploadedBy: actor.id,
      })
      .returning({ id: docFiles.id, path: docFiles.path, createdAt: docFiles.createdAt });
    await touchProject(ctx.db, docId);
    await ctx.audit({
      action: 'file.upload',
      resourceType: 'doc_file',
      resourceId: row.id,
      metadata: {
        doc_id: docId,
        path: row.path,
        mime_type: mimeFromExt,
        size_bytes: upload.body.length,
      },
    });
    return {
      id: row.id,
      path: row.path,
      kind: 'blob',
      yjs_doc_id: null,
      mime_type: mimeFromExt,
      size_bytes: upload.body.length,
      filename,
      created_at: row.createdAt.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The orphaned S3 object is small and re-uploads land on a fresh key;
      // not worth a compensating delete on this path.
      throw new PathTakenError();
    }
    throw err;
  }
}

export async function renameFile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  fileId: string,
  newPath: string,
): Promise<{ id: string; path: string }> {
  await assertCanWrite(ctx.acl, actor.id, docId);

  const v = validatePath(newPath);
  if ('error' in v) throw new InvalidPathError(v.error);

  const [existing] = await ctx.db
    .select({ id: docFiles.id, path: docFiles.path, kind: docFiles.kind })
    .from(docFiles)
    .where(and(eq(docFiles.id, fileId), eq(docFiles.docId, docId)))
    .limit(1);
  if (!existing) throw new FileNotFoundError();
  // The compile worker resolves the entrypoint by path, so renaming it would
  // leave the project uncompilable.
  if (isMainEntrypoint(existing.path)) throw new MainFileLockedError('renamed');

  try {
    if (existing.kind === 'folder') {
      // Rewrite every descendant's prefix in the same transaction, so there is
      // no window where the folder moved but its children still point at the
      // old prefix.
      const oldPrefix = `${existing.path}/`;
      const newPrefix = `${v.path}/`;
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(docFiles)
          .set({ path: v.path, updatedAt: new Date() })
          .where(eq(docFiles.id, fileId));
        await tx
          .update(docFiles)
          .set({
            path: sql`${newPrefix} || substr(${docFiles.path}, ${oldPrefix.length + 1})`,
            updatedAt: new Date(),
          })
          .where(and(eq(docFiles.docId, docId), sql`${docFiles.path} LIKE ${oldPrefix + '%'}`));
      });
      await touchProject(ctx.db, docId);
      await ctx.audit({
        action: 'file.rename',
        resourceType: 'doc_file',
        resourceId: existing.id,
        metadata: { doc_id: docId, from: existing.path, to: v.path, kind: 'folder' },
      });
      return { id: existing.id, path: v.path };
    }

    const [row] = await ctx.db
      .update(docFiles)
      .set({ path: v.path, updatedAt: new Date() })
      .where(eq(docFiles.id, fileId))
      .returning({ id: docFiles.id, path: docFiles.path });
    await touchProject(ctx.db, docId);
    await ctx.audit({
      action: 'file.rename',
      resourceType: 'doc_file',
      resourceId: row.id,
      metadata: { doc_id: docId, from: existing.path, to: row.path },
    });
    return { id: row.id, path: row.path };
  } catch (err) {
    if (isUniqueViolation(err)) throw new PathTakenError();
    throw err;
  }
}

/**
 * Delete a file, folder or blob.
 *
 * `expectBlob` scopes the lookup to `kind = 'blob'`, which is what the legacy
 * `/assets/:assetId` surface addresses.
 */
export async function deleteFile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  fileId: string,
  opts: { expectBlob?: boolean } = {},
): Promise<void> {
  await assertCanWrite(ctx.acl, actor.id, docId);

  const conditions = [eq(docFiles.id, fileId), eq(docFiles.docId, docId)];
  if (opts.expectBlob) conditions.push(eq(docFiles.kind, 'blob'));

  const [existing] = await ctx.db
    .select({
      id: docFiles.id,
      path: docFiles.path,
      kind: docFiles.kind,
      storageKey: docFiles.storageKey,
    })
    .from(docFiles)
    .where(and(...conditions))
    .limit(1);
  if (!existing || (opts.expectBlob && !existing.storageKey)) {
    throw new FileNotFoundError(opts.expectBlob ? 'Asset' : 'File');
  }
  if (isMainEntrypoint(existing.path)) throw new MainFileLockedError('deleted');

  if (existing.kind === 'folder') {
    // Refuse a non-empty folder rather than cascading deletions — including
    // blob-storage cleanup — the user did not think they were asking for.
    const childPrefix = `${existing.path}/`;
    const [{ count }] = (await ctx.db
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(docFiles)
      .where(
        and(eq(docFiles.docId, docId), sql`${docFiles.path} LIKE ${childPrefix + '%'}`),
      )) as Array<{
      count: string;
    }>;
    const childCount = parseInt(count, 10);
    if (childCount > 0) throw new FolderNotEmptyError(childCount);
  }

  if (existing.kind === 'blob' && existing.storageKey) {
    // Deleting a row must not destroy bytes something else can still reach
    // (#82). Two other references exist: a project checkpoint that pinned the
    // key, and another doc_files row sharing it — forked documents inherit a
    // template's storage keys BY REFERENCE, so a template and every fork share
    // one S3 object per blob. Only the last reference frees the bytes.
    const [pinned] = await ctx.db
      .select({ id: docProjectCheckpointBlobs.id })
      .from(docProjectCheckpointBlobs)
      .where(eq(docProjectCheckpointBlobs.storageKey, existing.storageKey))
      .limit(1);
    const [shared] = await ctx.db
      .select({ id: docFiles.id })
      .from(docFiles)
      .where(and(eq(docFiles.storageKey, existing.storageKey), ne(docFiles.id, existing.id)))
      .limit(1);
    if (!pinned && !shared) await ctx.blobs.delete(existing.storageKey);
  }

  // For text files the FK cascade from doc_files → doc_updates /
  // doc_snapshots / doc_checkpoints (retargeted in ADR 0013) handles the Yjs
  // storage, so one DELETE is enough.
  await ctx.db.delete(docFiles).where(eq(docFiles.id, fileId));
  await touchProject(ctx.db, docId);
  await ctx.audit({
    action: 'file.delete',
    resourceType: 'doc_file',
    resourceId: existing.id,
    metadata: { doc_id: docId, path: existing.path, kind: existing.kind },
  });
}

export { MAX_SINGLE_BYTES };

export class NotATextFileError extends Error {
  readonly statusCode = 422;
  readonly code = 'not_a_text_file';
  constructor() {
    super('Only text files have content; blobs are fetched as bytes and folders have none');
  }
}

export class RevisionMismatchError extends Error {
  readonly statusCode = 412;
  readonly code = 'revision_mismatch';
  readonly payload: { rev: string };
  constructor(current: bigint) {
    super('The file changed since the revision you supplied');
    this.payload = { rev: current.toString() };
  }
}

async function findTextFile(ctx: ServiceContext, docId: string, fileId: string) {
  const [row] = await ctx.db
    .select({
      id: docFiles.id,
      path: docFiles.path,
      kind: docFiles.kind,
      yjsDocId: docFiles.yjsDocId,
    })
    .from(docFiles)
    .where(and(eq(docFiles.id, fileId), eq(docFiles.docId, docId)))
    .limit(1);
  if (!row) throw new FileNotFoundError();
  if (row.kind !== 'text' || !row.yjsDocId) throw new NotATextFileError();
  return row as { id: string; path: string; kind: string; yjsDocId: string };
}

export interface TextContent {
  path: string;
  content: string;
  /** The Yjs sequence this content was read at. Pass it back as `if_rev`. */
  rev: string;
}

/**
 * Read a text file's content as a plain string.
 *
 * The source of truth is a Yjs document, not a column, so this materialises
 * the CRDT and reads its `source` text — exactly what the compile worker does.
 * There is no cheaper path that is also correct.
 */
export async function readTextFile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  fileId: string,
): Promise<TextContent> {
  await assertCanRead(ctx.acl, actor.id, docId);
  const file = await findTextFile(ctx, docId, fileId);

  const crdt: CrdtDeps = { db: ctx.db, blobs: ctx.blobs };
  const loaded = await loadDoc(crdt, file.yjsDocId);
  try {
    return {
      path: file.path,
      content: loaded.doc.getText('source').toString(),
      // nextSeq is the seq the NEXT update would take, so the current
      // revision is one behind it.
      rev: String(BigInt(loaded.nextSeq) - 1n),
    };
  } finally {
    loaded.doc.destroy();
  }
}

/**
 * Replace a text file's content.
 *
 * Applies the new text as a single Yjs transaction against the live document
 * rather than writing a column — which is what keeps a concurrent editor's
 * session coherent instead of desynchronised. Same mechanic as a checkpoint
 * restore.
 *
 * `ifRev` is optional optimistic concurrency: supply the `rev` you read and
 * the write is refused with 412 if anything landed in between. Omit it and
 * last-writer-wins, which is what a first-time scripted caller expects.
 */
export async function writeTextFile(
  ctx: ServiceContext,
  actor: Actor,
  docId: string,
  fileId: string,
  input: { content: string; ifRev?: string },
): Promise<{ path: string; rev: string }> {
  await assertWritableProject(ctx, actor, docId);
  const file = await findTextFile(ctx, docId, fileId);

  const crdt: CrdtDeps = { db: ctx.db, blobs: ctx.blobs };
  const loaded = await loadDoc(crdt, file.yjsDocId);
  const doc = loaded.doc;
  try {
    const currentRev = BigInt(loaded.nextSeq) - 1n;
    if (input.ifRev !== undefined && input.ifRev !== currentRev.toString()) {
      throw new RevisionMismatchError(currentRev);
    }

    const beforeSv = Y.encodeStateVector(doc);
    const text = doc.getText('source');
    doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, input.content);
    });
    const update = Y.encodeStateAsUpdate(doc, beforeSv);
    await persistUpdate(crdt, file.yjsDocId, loaded.nextSeq, update, actor.id);
  } finally {
    doc.destroy();
  }

  await touchProject(ctx.db, docId);
  // Live editors must re-bootstrap, or they keep showing the old text and
  // their next keystroke reintroduces it.
  await evictRoom(ctx.db, file.yjsDocId);
  await ctx.audit({
    action: 'file.write',
    resourceType: 'doc_file',
    resourceId: file.id,
    metadata: { doc_id: docId, path: file.path, bytes: Buffer.byteLength(input.content) },
  });

  return { path: file.path, rev: String(loaded.nextSeq) };
}
