import { describe, expect, it } from 'vitest';

import {
  SECRET_ENTROPY_BYTES,
  TOKEN_PREFIX,
  bearerFrom,
  hashToken,
  mintToken,
  parseTokenId,
  scopeAllows,
  tokenMatches,
} from './tokens.js';

describe('mintToken', () => {
  it('produces aeolus_<16 hex>_<secret> with the id as a usable row key', () => {
    const { id, token, hash } = mintToken();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(token.startsWith(`${TOKEN_PREFIX}${id}_`)).toBe(true);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the advertised entropy in the secret half', () => {
    const { token, id } = mintToken();
    const secret = token.slice(`${TOKEN_PREFIX}${id}_`.length);
    // base64url of N bytes is ceil(N*4/3) chars with no padding.
    expect(secret.length).toBe(Math.ceil((SECRET_ENTROPY_BYTES * 4) / 3));
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintToken().id));
    expect(ids.size).toBe(200);
  });
});

describe('parseTokenId', () => {
  it('extracts the id from a well-formed token', () => {
    const { id, token } = mintToken();
    expect(parseTokenId(token)).toBe(id);
  });

  // Each of these must cost ZERO database queries — the whole point of
  // shape-checking before the lookup.
  it.each([
    ['empty', ''],
    ['no prefix', 'abc123'],
    ['wrong prefix', 'dilv_0123456789abcdef_' + 'x'.repeat(43)],
    ['no separator', `${TOKEN_PREFIX}0123456789abcdef`],
    ['empty id', `${TOKEN_PREFIX}_${'x'.repeat(43)}`],
    ['short id', `${TOKEN_PREFIX}0123_${'x'.repeat(43)}`],
    ['non-hex id', `${TOKEN_PREFIX}zzzzzzzzzzzzzzzz_${'x'.repeat(43)}`],
    ['uppercase id', `${TOKEN_PREFIX}0123456789ABCDEF_${'x'.repeat(43)}`],
    ['short secret', `${TOKEN_PREFIX}0123456789abcdef_short`],
  ])('rejects %s without a lookup', (_label, presented) => {
    expect(parseTokenId(presented)).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('accepts the token it was minted from', () => {
    const { token, hash } = mintToken();
    expect(tokenMatches(token, hash)).toBe(true);
  });

  it('rejects a different token with a valid-looking hash', () => {
    const a = mintToken();
    const b = mintToken();
    expect(tokenMatches(a.token, b.hash)).toBe(false);
  });

  it('rejects a token whose id matches but whose secret does not', () => {
    const { id, hash } = mintToken();
    expect(tokenMatches(`${TOKEN_PREFIX}${id}_${'x'.repeat(43)}`, hash)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['not hex', 'z'.repeat(64)],
    ['too long', 'a'.repeat(65)],
  ])('refuses a malformed stored hash (%s) rather than throwing', (_label, stored) => {
    const { token } = mintToken();
    expect(tokenMatches(token, stored)).toBe(false);
  });
});

describe('scopeAllows — the gate must fail CLOSED', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'head'])('lets a read token use %s', (method) => {
    expect(scopeAllows('read', method)).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete'])(
    'refuses a read token on %s',
    (method) => {
      expect(scopeAllows('read', method)).toBe(false);
    },
  );

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('lets a write token use %s', (method) => {
    expect(scopeAllows('write', method)).toBe(true);
  });

  // The property that matters: a row carrying a value nobody planned for —
  // a partial migration, a hand-edited row, a future scope this build predates
  // — must read as read-only, never as unrestricted.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['unknown word', 'admin'],
    ['near miss', 'writes'],
    ['wrong case', 'WRITE'],
    ['padded', ' write'],
  ])('treats %s as read-only for writes', (_label, scope) => {
    expect(scopeAllows(scope as string | null | undefined, 'POST')).toBe(false);
    expect(scopeAllows(scope as string | null | undefined, 'GET')).toBe(true);
  });
});

describe('bearerFrom', () => {
  it('pulls the credential out of a well-formed header', () => {
    expect(bearerFrom('Bearer aeolus_abc')).toBe('aeolus_abc');
  });

  it('is case-insensitive on the scheme and tolerant of extra spacing', () => {
    expect(bearerFrom('bearer   aeolus_abc')).toBe('aeolus_abc');
    expect(bearerFrom('  BEARER\taeolus_abc  ')).toBe('aeolus_abc');
  });

  it('takes the first value when the header is repeated', () => {
    expect(bearerFrom(['Bearer one', 'Bearer two'])).toBe('one');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['scheme only', 'Bearer'],
    ['scheme and space only', 'Bearer '],
    ['a different scheme', 'Basic Zm9vOmJhcg=='],
    ['two values', 'Bearer a b'],
  ])('returns null for %s', (_label, header) => {
    expect(bearerFrom(header as string | undefined)).toBeNull();
  });
});
