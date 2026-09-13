/**
 * Errors shared across service domains.
 *
 * Each carries `statusCode` and `code`, which is the whole contract: both
 * planes' error handlers read those two fields, so a service never chooses a
 * status and never formats a body. A `payload` object, where present, is
 * merged into the response for 4xx only — that is how a contract field like
 * `folder_not_empty`'s `children` survives the trip.
 */

export class AdminOnlyError extends Error {
  readonly statusCode = 403;
  readonly code = 'forbidden';
  constructor() {
    super('You do not have permission to perform this action');
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
  constructor(what = 'Resource') {
    super(`${what} not found`);
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'conflict';
  constructor(message: string) {
    super(message);
  }
}
