import { describe, expect, it } from 'vitest';

import { wsInternalBase } from './admin-diagnostics.js';

// AEOLUS_WS_INTERNAL_URL is where api forwards the operator's session cookie
// to read ws's diagnostics ring. The api makes that request on the operator's
// behalf, so the value only has to be a plausible internal URL — but a typo
// must be refused loudly rather than dialled.
describe('wsInternalBase', () => {
  it('defaults to the compose service, which is what a stock install has', () => {
    expect(wsInternalBase({})).toBe('http://ws:8080');
  });

  it('keeps the origin and drops any path or query', () => {
    expect(wsInternalBase({ AEOLUS_WS_INTERNAL_URL: 'https://ws.internal:8081/anything?x' })).toBe(
      'https://ws.internal:8081',
    );
  });

  it('accepts loopback for a laptop', () => {
    expect(wsInternalBase({ AEOLUS_WS_INTERNAL_URL: 'http://localhost:8081' })).toBe(
      'http://localhost:8081',
    );
  });

  it('refuses anything that is not a bare http(s) URL', () => {
    for (const bad of [
      'not a url',
      'ftp://ws.internal/',
      'file:///etc/passwd',
      // Credentials in the URL would be sent along with the session cookie.
      'https://user:secret@ws.internal/',
    ]) {
      expect(() => wsInternalBase({ AEOLUS_WS_INTERNAL_URL: bad })).toThrow(
        /AEOLUS_WS_INTERNAL_URL/,
      );
    }
  });
});
