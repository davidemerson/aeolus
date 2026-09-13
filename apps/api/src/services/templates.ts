import crypto from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';
import * as Y from 'yjs';

import { loadDoc, persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { docFiles, docs, templates } from '@aeolus/db';

import type { Actor } from '../actor.js';
import type { ServiceContext } from './context.js';
import type { DocEngine } from './docs.js';
import { AdminOnlyError, NotFoundError } from './errors.js';

/**
 * Admin-curated document templates, and the fork that turns one into a
 * working document.
 *
 * Fork is the path every non-admin uses to create anything, so it is the most
 * load-bearing routine in this file by some distance.
 */

export interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  engine: DocEngine;
  is_published: boolean;
  yjs_doc_id: string;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  engine: string;
  isPublished: boolean;
  yjsDocId: string;
  createdBy: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const templateColumns = {
  id: templates.id,
  name: templates.name,
  description: templates.description,
  engine: templates.engine,
  isPublished: templates.isPublished,
  yjsDocId: templates.yjsDocId,
  createdBy: templates.createdBy,
  deletedAt: templates.deletedAt,
  createdAt: templates.createdAt,
  updatedAt: templates.updatedAt,
};

function asEngine(v: string): DocEngine {
  return v === 'typst' ? 'typst' : 'latex';
}

export function toTemplateView(row: TemplateRow): TemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    engine: asEngine(row.engine),
    is_published: row.isPublished,
    yjs_doc_id: row.yjsDocId,
    created_by: row.createdBy,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const templateNotFound = () => new NotFoundError('Template');

export async function listTemplates(ctx: ServiceContext, actor: Actor): Promise<TemplateView[]> {
  // An unpublished template is a draft: invisible to everyone but an admin.
  const where = actor.isAdmin
    ? isNull(templates.deletedAt)
    : and(isNull(templates.deletedAt), eq(templates.isPublished, true));
  const rows = await ctx.db
    .select(templateColumns)
    .from(templates)
    .where(where)
    .orderBy(desc(templates.updatedAt));
  return rows.map(toTemplateView);
}

export async function getTemplate(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
): Promise<TemplateView> {
  const [row] = await ctx.db
    .select(templateColumns)
    .from(templates)
    .where(eq(templates.id, id))
    .limit(1);
  if (!row || row.deletedAt !== null) throw templateNotFound();
  // 404 rather than 403 for an unpublished draft: same existence-hiding rule
  // as documents (ADR 0003).
  if (!actor.isAdmin && !row.isPublished) throw templateNotFound();
  return toTemplateView(row);
}

export async function createTemplate(
  ctx: ServiceContext,
  actor: Actor,
  input: { name: string; description?: string | null; engine: DocEngine },
): Promise<TemplateView> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const row = await ctx.db.transaction(async (tx) => {
    // A template is backed by a real document flagged `is_template_doc`, so
    // the editor can open it with no special case.
    const [doc] = await tx
      .insert(docs)
      .values({
        title: input.name,
        engine: input.engine,
        ownerId: actor.id,
        isTemplateDoc: true,
      })
      .returning({ id: docs.id });
    await tx.insert(docFiles).values({
      docId: doc.id,
      path: input.engine === 'typst' ? 'main.typ' : 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });
    const [tmpl] = await tx
      .insert(templates)
      .values({
        name: input.name,
        description: input.description ?? null,
        engine: input.engine,
        yjsDocId: doc.id,
        createdBy: actor.id,
      })
      .returning(templateColumns);
    return tmpl;
  });

  await ctx.audit({
    action: 'template.create',
    resourceType: 'template',
    resourceId: row.id,
    metadata: { name: input.name, engine: input.engine },
  });
  return toTemplateView(row);
}

export async function updateTemplate(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: { name?: string; description?: string | null; isPublished?: boolean },
): Promise<TemplateView> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const [existing] = await ctx.db
    .select({ id: templates.id, deletedAt: templates.deletedAt })
    .from(templates)
    .where(eq(templates.id, id))
    .limit(1);
  if (!existing || existing.deletedAt !== null) throw templateNotFound();

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.isPublished !== undefined) patch.isPublished = input.isPublished;

  const [updated] = await ctx.db
    .update(templates)
    .set(patch)
    .where(eq(templates.id, id))
    .returning(templateColumns);
  if (!updated) throw templateNotFound();

  await ctx.audit({
    action: 'template.update',
    resourceType: 'template',
    resourceId: updated.id,
    // Normalised — the same publish action must record one shape in the audit
    // trail regardless of which spelling the caller sent.
    metadata: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isPublished !== undefined ? { is_published: input.isPublished } : {}),
    },
  });
  return toTemplateView(updated);
}

export async function deleteTemplate(ctx: ServiceContext, actor: Actor, id: string): Promise<void> {
  if (!actor.isAdmin) throw new AdminOnlyError();

  const now = new Date();
  const row = await ctx.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: templates.id,
        yjsDocId: templates.yjsDocId,
        deletedAt: templates.deletedAt,
      })
      .from(templates)
      .where(eq(templates.id, id))
      .limit(1);
    if (!existing || existing.deletedAt !== null) return null;
    await tx.update(templates).set({ deletedAt: now, updatedAt: now }).where(eq(templates.id, id));
    // The backing document goes with it, or it would linger in admin listings
    // as an orphan nobody can reach.
    await tx
      .update(docs)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(docs.id, existing.yjsDocId));
    return existing;
  });
  if (!row) throw templateNotFound();

  await ctx.audit({ action: 'template.delete', resourceType: 'template', resourceId: id });
}

export interface ForkResult {
  doc_id: string;
  title: string;
  text_files_copied: number;
  blobs_copied: number;
}

/**
 * Fork a template into a new document owned by the caller.
 *
 * The path every non-admin uses to create anything, so the details matter:
 *
 * - **Every text file is copied, not just the entrypoint.** Each carries its
 *   own `yjs_doc_id` (ADR 0013); copying only main silently dropped `\input`
 *   siblings at compile time (issue #36).
 * - **Main keeps `yjs_doc_id == docs.id`.** Legacy single-file callers and the
 *   WebSocket's "no fileId means main" fallback both resolve through that
 *   convention. Siblings mint fresh UUIDs.
 * - **Blobs are copied BY REFERENCE.** Duplicating bytes per fork would
 *   explode storage for a popular template and buys nothing, since a fork is a
 *   snapshot of the template at fork time. The GC sweep treats a key
 *   referenced by any `doc_files` row as live, and the delete path checks for
 *   sharers (#82) — so a template deleting its logo does not pull it out from
 *   under existing forks.
 */
export async function forkTemplate(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: { title?: string } = {},
): Promise<ForkResult> {
  const [tmpl] = await ctx.db
    .select(templateColumns)
    .from(templates)
    .where(eq(templates.id, id))
    .limit(1);
  if (!tmpl || tmpl.deletedAt !== null) throw templateNotFound();
  if (!actor.isAdmin && !tmpl.isPublished) throw templateNotFound();

  const crdt: CrdtDeps = { db: ctx.db, blobs: ctx.blobs };
  const mainPath = tmpl.engine === 'typst' ? 'main.typ' : 'main.tex';
  const newDocId = crypto.randomUUID();

  const templateTextFiles = await ctx.db
    .select({ path: docFiles.path, yjsDocId: docFiles.yjsDocId })
    .from(docFiles)
    .where(and(eq(docFiles.docId, tmpl.yjsDocId), eq(docFiles.kind, 'text')));

  interface ForkedTextFile {
    path: string;
    newYjsDocId: string;
    snapshot: Uint8Array;
  }
  // Encoded outside the transaction so the transaction stays short.
  const forkedTextFiles: ForkedTextFile[] = await Promise.all(
    templateTextFiles
      .filter((f): f is { path: string; yjsDocId: string } => f.yjsDocId !== null)
      .map(async (f) => {
        const loaded = await loadDoc(crdt, f.yjsDocId);
        const snapshot = Y.encodeStateAsUpdate(loaded.doc);
        loaded.doc.destroy();
        return {
          path: f.path,
          newYjsDocId: f.path === mainPath ? newDocId : crypto.randomUUID(),
          snapshot,
        };
      }),
  );

  // Defensive: a template with no main text file would leave the fork's
  // "no fileId means main" WebSocket fallback closing every upgrade with 1008.
  if (!forkedTextFiles.some((f) => f.path === mainPath)) {
    forkedTextFiles.unshift({ path: mainPath, newYjsDocId: newDocId, snapshot: new Uint8Array() });
  }

  const templateBlobs = await ctx.db
    .select({
      path: docFiles.path,
      storageKey: docFiles.storageKey,
      filename: docFiles.filename,
      mimeType: docFiles.mimeType,
      sizeBytes: docFiles.sizeBytes,
    })
    .from(docFiles)
    .where(and(eq(docFiles.docId, tmpl.yjsDocId), eq(docFiles.kind, 'blob')));

  const title = input.title?.trim() || tmpl.name;

  const newDoc = await ctx.db.transaction(async (tx) => {
    const [d] = await tx
      .insert(docs)
      .values({
        id: newDocId,
        title,
        engine: tmpl.engine,
        ownerId: actor.id,
        forkedFromTemplate: tmpl.id,
      })
      .returning({ id: docs.id });

    await tx.insert(docFiles).values(
      forkedTextFiles.map((f) => ({
        docId: d.id,
        path: f.path,
        kind: 'text' as const,
        yjsDocId: f.newYjsDocId,
      })),
    );

    if (templateBlobs.length > 0) {
      await tx.insert(docFiles).values(
        templateBlobs.map((b) => ({
          docId: d.id,
          path: b.path,
          kind: 'blob' as const,
          storageKey: b.storageKey,
          filename: b.filename,
          mimeType: b.mimeType,
          sizeBytes: b.sizeBytes,
          uploadedBy: actor.id,
        })),
      );
    }
    return d;
  });

  // After the doc_files insert: the FK requires the row to exist (ADR 0013).
  // An empty snapshot is a Yjs no-op, so a synthesised main is skipped.
  for (const f of forkedTextFiles) {
    if (f.snapshot.byteLength > 0) {
      await persistUpdate(crdt, f.newYjsDocId, 0n, f.snapshot, actor.id);
    }
  }

  await ctx.audit({
    action: 'template.fork',
    resourceType: 'doc',
    resourceId: newDoc.id,
    metadata: {
      template_id: tmpl.id,
      title,
      text_files_copied: forkedTextFiles.length,
      blobs_copied: templateBlobs.length,
    },
  });

  return {
    doc_id: newDoc.id,
    title,
    text_files_copied: forkedTextFiles.length,
    blobs_copied: templateBlobs.length,
  };
}
