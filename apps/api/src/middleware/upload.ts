import type { FastifyRequest } from 'fastify';

import { MAX_SINGLE_BYTES } from '../services/file-paths.js';
import { FileTooLargeError } from '../services/files.js';

export interface DrainedUpload {
  body: Buffer;
  /** The `path` form field when present, else the upload's own filename. */
  rawPath: string;
  filename: string;
}

/**
 * Drain a multipart upload into memory, refusing anything over the cap.
 *
 * Kept beside the routes rather than in a service: it is the one part of an
 * upload that is irreducibly about the HTTP request. Three routes (browser
 * /docs/:id/files, browser /docs/:id/assets, v1 files) carried their own copy;
 * they differed only in whether the `path` field was read.
 */
export async function drainUpload(request: FastifyRequest): Promise<DrainedUpload | null> {
  const upload = await request.file({ limits: { fileSize: MAX_SINGLE_BYTES } });
  if (!upload) return null;

  const pathField = upload.fields?.path;
  let rawPath = upload.filename;
  if (Array.isArray(pathField)) {
    const f = pathField[0];
    if (f && 'value' in f && typeof f.value === 'string') rawPath = f.value;
  } else if (pathField && 'value' in pathField && typeof pathField.value === 'string') {
    rawPath = pathField.value;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of upload.file) {
    size += chunk.length;
    if (size > MAX_SINGLE_BYTES) throw new FileTooLargeError();
    chunks.push(Buffer.from(chunk));
  }
  if (upload.file.truncated) throw new FileTooLargeError();
  return { body: Buffer.concat(chunks), rawPath, filename: upload.filename };
}
