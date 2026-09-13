import { describe, expect, it } from 'vitest';

import { publicError } from './reply-errors.js';

describe('publicError', () => {
  it('passes a deliberate domain error through', () => {
    expect(
      publicError({ statusCode: 503, code: 'compile_unavailable', message: 'No worker' }),
    ).toEqual({
      status: 503,
      code: 'compile_unavailable',
      message: 'No worker',
      hide: false,
    });
  });

  it('hides an unexpected 5xx', () => {
    const pub = publicError({ message: 'connect ECONNREFUSED 10.0.0.5:5432' });
    expect(pub).toEqual({
      status: 500,
      code: 'internal_error',
      message: 'Internal server error',
      hide: true,
    });
  });

  it("maps Fastify's body-too-large to the house 413", () => {
    const pub = publicError({
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      message: 'Request body is too large',
    });
    expect(pub.status).toBe(413);
    expect(pub.code).toBe('payload_too_large');
    expect(pub.code).not.toContain('FST_ERR');
  });

  it('maps an unknown 4xx Fastify code to request_failed and hides an unknown 5xx one', () => {
    expect(publicError({ statusCode: 400, code: 'FST_ERR_SOMETHING_NEW', message: 'x' }).code).toBe(
      'request_failed',
    );
    expect(
      publicError({ statusCode: 500, code: 'FST_ERR_INTERNAL_THING', message: 'x' }),
    ).toMatchObject({
      code: 'internal_error',
      hide: true,
    });
  });

  it('maps an http-errors-shaped 413 (status text in `error`, no code) to payload_too_large', () => {
    const pub = publicError({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'Request body is too large',
    });
    expect(pub).toMatchObject({ status: 413, code: 'payload_too_large', hide: false });
    expect(publicError({ statusCode: 418, error: 'Im A Teapot', message: 'x' }).code).toBe(
      'im_a_teapot',
    );
  });

  it('prefers `error` over `code` when both are set (v1 rate-limit builder shape)', () => {
    expect(
      publicError({ statusCode: 429, error: 'rate_limited', code: 'x', message: 'slow down' }).code,
    ).toBe('rate_limited');
  });
});
