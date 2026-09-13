import path from 'node:path';

import { and, eq } from 'drizzle-orm';

import { docFiles, type Database } from '@aeolus/db';

/**
 * Path, MIME and quota rules for a project's file tree.
 *
 * These constants and helpers previously existed **twice**, verbatim, in
 * `routes/files.ts` and `routes/assets.ts` — the duplication `files.ts` has
 * flagged since it was written ("phase 4 of issue #9 will collapse the two
 * endpoints"). This module is that collapse. Both surfaces, and `/api/v1`,
 * now share one definition, so a change to the allowlist or a cap cannot
 * apply to one upload path and not the other.
 */

/** Upload allowlist, keyed by lowercased extension. */
export const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.bib': 'application/x-bibtex',
  '.cls': 'text/plain',
  '.sty': 'text/plain',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.csv': 'text/csv',
};

export const MAX_SINGLE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/**
 * Relative, no traversal, no leading slash, bounded per segment and in total.
 *
 * Worth knowing why this is load-bearing beyond tidiness: since the WAF host
 * exemption in whatever sits in front, nothing upstream inspects `\input`
 * targets or request paths for traversal on this host. This validator and the
 * compile worker's own path handling are the controls.
 */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-][A-Za-z0-9._ -]{0,254}$/;

export function validatePath(raw: string): { path: string } | { error: string } {
  if (raw.length === 0 || raw.length > 1024) return { error: 'path_invalid_length' };
  const norm = raw.replace(/^\/+/, '');
  const segments = norm.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return { error: 'path_invalid_segment' };
    if (!PATH_SEGMENT_RE.test(seg)) return { error: 'path_invalid_chars' };
  }
  return { path: norm };
}

/** The two paths the compile worker resolves as a project's entrypoint. */
export function isMainEntrypoint(p: string): boolean {
  return p === 'main.tex' || p === 'main.typ';
}

/**
 * Resolve a free `doc_files.path`, appending `-2`, `-3`, … before the
 * extension. Used by the bare-filename upload surface, which dedupes rather
 * than 409ing. Bounded probe: a collision is rare, and looping forever on
 * pathological state is worse than surfacing it.
 */
export async function uniqueDocFilesPath(
  db: Database,
  docId: string,
  filename: string,
): Promise<string> {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? filename : `${stem}-${i + 1}${ext}`;
    const [hit] = await db
      .select({ id: docFiles.id })
      .from(docFiles)
      .where(and(eq(docFiles.docId, docId), eq(docFiles.path, candidate)))
      .limit(1);
    if (!hit) return candidate;
  }
  throw new Error(`Could not find a free doc_files path for ${filename}`);
}

/**
 * Is this a Postgres unique-violation (SQLSTATE 23505)?
 *
 * Drizzle wraps the driver error and re-throws, so the code can be on the
 * error itself or on `.cause` depending on driver version; the message check
 * is the last resort.
 */
export function isUniqueViolation(err: unknown): boolean {
  const candidates: unknown[] = [err];
  if (err && typeof err === 'object' && 'cause' in err) {
    candidates.push((err as { cause: unknown }).cause);
  }
  for (const c of candidates) {
    if (c && typeof c === 'object' && 'code' in c) {
      if ((c as { code: unknown }).code === '23505') return true;
    }
  }
  if (err instanceof Error && /unique constraint|duplicate key/i.test(err.message)) return true;
  return false;
}
