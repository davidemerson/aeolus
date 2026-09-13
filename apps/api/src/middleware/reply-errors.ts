import type { FastifyReply } from 'fastify';

// The house error envelope for the browser plane: `{ error, message }`.
//
// Twelve route modules each carried a private copy of `sendError` and eight
// a copy of `notFound` (admin, admin-diagnostics, admin-users, assets,
// checkpoints, compile, docs, files, project-checkpoints, project-zip,
// templates, tokens, ws-tickets), differing only in prettier wrapping — the
// same shape requireUser() was pulled out of. One definition, one place to
// change the envelope.

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({ error: code, message });
}

export function notFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, 'not_found', 'Not found');
}

// Fastify's own content-type-parser errors carry codes like
// FST_ERR_CTP_BODY_TOO_LARGE. Both error handlers used to put `err.code` on the
// wire verbatim, so a 1 MiB body produced `error: "FST_ERR_CTP_BODY_TOO_LARGE"`
// — and on the documented plane a code no route declares, which the response
// serializer then turned into a 500. This maps the ones a client can trigger
// to house codes and hides the rest behind `request_failed`.
const FASTIFY_PUBLIC_CODES: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: 'payload_too_large',
    message: 'Request body is larger than this endpoint accepts',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: 'unsupported_media_type',
    message: 'Unsupported content-type',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'invalid_body', message: 'Body must be JSON' },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: 'invalid_body',
    message: 'Body is not valid JSON',
  },
  FST_ERR_VALIDATION: {
    status: 400,
    code: 'invalid_request',
    message: 'Request failed validation',
  },
};

export interface PublicError {
  status: number;
  code: string;
  message: string;
}

/**
 * What a thrown error is allowed to say. App errors (`statusCode` + a lowercase
 * `code`/`error`) pass through; Fastify internals are mapped; anything else at
 * 5xx says nothing.
 */
export function publicError(err: {
  statusCode?: number;
  code?: string;
  error?: string;
  message: string;
}): PublicError & { hide: boolean } {
  const status = err.statusCode ?? 500;
  // Fastify's own errors carry the machine code in `code` and, via
  // http-errors, the status TEXT in `error` ("Payload Too Large") — which is
  // what used to reach the wire. Check `code` first.
  if (err.code && err.code.startsWith('FST_ERR_')) {
    const mapped = FASTIFY_PUBLIC_CODES[err.code];
    if (mapped) return { ...mapped, hide: false };
    return status >= 500
      ? { status, code: 'internal_error', message: 'Internal server error', hide: true }
      : { status, code: 'request_failed', message: err.message, hide: false };
  }
  // http-errors shape: no machine code, `error` is the status text
  // ("Payload Too Large"). Fastify's content-type parser limit and a
  // handful of plugin errors arrive like this. Map by status.
  if (!err.code && err.error && /^[A-Z][A-Za-z ]*$/.test(err.error)) {
    const byStatus: Record<number, PublicError> = {
      413: FASTIFY_PUBLIC_CODES.FST_ERR_CTP_BODY_TOO_LARGE,
      415: FASTIFY_PUBLIC_CODES.FST_ERR_CTP_INVALID_MEDIA_TYPE,
    };
    const mapped = byStatus[status];
    if (mapped) return { ...mapped, hide: false };
    return status >= 500
      ? { status, code: 'internal_error', message: 'Internal server error', hide: true }
      : {
          status,
          code: err.error.toLowerCase().replace(/ /g, '_'),
          message: err.message,
          hide: false,
        };
  }
  const raw = err.error ?? err.code;
  const deliberate = err.statusCode !== undefined && raw !== undefined;
  const hide = status >= 500 && !deliberate;
  return {
    status,
    code: hide ? 'internal_error' : (raw ?? 'request_failed'),
    message: hide ? 'Internal server error' : err.message,
    hide,
  };
}
