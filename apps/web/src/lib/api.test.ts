import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiRequestError, reportUnauthenticated, setUnauthenticatedHandler } from './api.js';

// The 401 hook lets the SPA root translate any auth failure into a
// /login redirect instead of letting the API's "Not signed in" body
// bleed into whichever component made the call (e.g. compile failure
// surfacing as "Compile failed — Not signed in" in the right pane).
describe('api — 401 hook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    setUnauthenticatedHandler(null);
    vi.unstubAllGlobals();
  });

  function reply(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('fires the handler when a request returns 401 and still throws', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(401, { error: 'unauthenticated', message: 'Not signed in' }),
    );
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);

    await expect(api.post('/docs/abc/compile')).rejects.toBeInstanceOf(ApiRequestError);
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });

  it('does not fire on non-401 errors', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(404, { error: 'not_found', message: 'Document not found' }),
    );
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);

    await expect(api.get('/docs/abc')).rejects.toBeInstanceOf(ApiRequestError);
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it('does not fire on 2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true }));
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);

    const out = await api.get<{ ok: boolean }>('/me');
    expect(out).toEqual({ ok: true });
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it('uses the latest handler', async () => {
    const first = vi.fn();
    const second = vi.fn();
    setUnauthenticatedHandler(first);
    setUnauthenticatedHandler(second);

    fetchMock.mockResolvedValueOnce(
      reply(401, { error: 'unauthenticated', message: 'Not signed in' }),
    );
    await expect(api.get('/me')).rejects.toBeInstanceOf(ApiRequestError);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no handler is registered', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(401, { error: 'unauthenticated', message: 'Not signed in' }),
    );
    // No setUnauthenticatedHandler call. Must not throw beyond the
    // ApiRequestError that callers already handle.
    await expect(api.get('/me')).rejects.toBeInstanceOf(ApiRequestError);
  });
});

// getBytes is the binary sibling of get (checkpoint snapshots are raw Yjs
// updates). It has to carry the same 401 hook, or a stale session opening a
// checkpoint would show "Failed to load checkpoint" instead of /login.
describe('api — getBytes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    setUnauthenticatedHandler(null);
    vi.unstubAllGlobals();
  });

  it('returns the response body as bytes and sends the session cookie', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const out = await api.getBytes('/docs/abc/checkpoints/cp1/download');
    expect(Array.from(out)).toEqual([1, 2, 3]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/docs/abc/checkpoints/cp1/download');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
  });

  it('fires the 401 handler and throws an ApiRequestError', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthenticated', message: 'Not signed in' }), {
        status: 401,
      }),
    );
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);
    await expect(api.getBytes('/docs/abc/checkpoints/cp1/download')).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });

  it('throws a typed error carrying the status for non-JSON failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }));
    const err = await api.getBytes('/docs/abc/checkpoints/cp1/download').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(504);
  });
});

// Components toast `err.message` straight to the user, so a failure with no
// body must still carry a sentence — never an empty string, never the HTTP
// reason phrase.
describe('api — error message fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the server message when the body has one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'self_delete', message: 'You cannot delete yourself.' }),
            {
              status: 422,
            },
          ),
      ),
    );
    const err = (await api.delete('/admin/users/me').catch((e: unknown) => e)) as ApiRequestError;
    expect(err.code).toBe('self_delete');
    expect(err.message).toBe('You cannot delete yourself.');
  });

  it('falls back to a generic sentence for an empty body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 502, statusText: 'Bad Gateway' })),
    );
    const err = (await api
      .post('/admin/users/u1/disable')
      .catch((e: unknown) => e)) as ApiRequestError;
    expect(err.status).toBe(502);
    expect(err.code).toBe('request_failed');
    expect(err.message).toBe('The request could not be completed.');
  });
});

// The multipart upload and the AI SSE stream cannot use `api`; they call this
// on a 401 so the redirect still happens for them.
describe('reportUnauthenticated', () => {
  afterEach(() => setUnauthenticatedHandler(null));

  it('invokes the registered handler, and is a no-op without one', () => {
    expect(() => reportUnauthenticated()).not.toThrow();
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);
    reportUnauthenticated();
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });
});
