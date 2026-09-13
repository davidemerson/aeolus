import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useCompileLifecycle } from './useCompileLifecycle.js';

// The session stays 'loading' so the mount-time restore/compile-on-open
// effects do not fire; every request in these tests comes from an explicit
// triggerCompile() call.
vi.mock('../lib/session.js', () => ({
  useSession: () => ({ status: 'loading' as const }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Call {
  url: string;
  method: string;
}

function installFetch(statusBody: () => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      if (method === 'POST' && u.endsWith('/compile')) {
        return json({ job_id: 'job-1', status: 'queued' });
      }
      if (method === 'GET' && u.includes('/compile/job-1')) {
        return json(statusBody());
      }
      return new Response('{}', { status: 404 });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useCompileLifecycle — poll loop cancellation', () => {
  it('stops polling once the hook unmounts', async () => {
    const calls = installFetch(() => ({
      status: 'running',
      pdf_url: null,
      synctex_url: null,
      error: null,
    }));
    const { result, unmount } = renderHook(() => useCompileLifecycle('doc-1', false));

    await act(async () => {
      void result.current.triggerCompile();
      // POST + first GET happen on microtasks; the 500 ms back-off then
      // yields a second GET.
      await vi.advanceTimersByTimeAsync(600);
    });
    const posts = calls.filter((c) => c.method === 'POST').length;
    const getsBefore = calls.filter((c) => c.method === 'GET').length;
    expect(posts).toBe(1);
    expect(getsBefore).toBeGreaterThanOrEqual(2);
    expect(result.current.compileState).toBe('running');

    unmount();
    const total = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // Not one more request after unmount — the pending back-off timer
    // resolved into the abort, not into another GET.
    expect(calls.length).toBe(total);
  });

  it('still completes a compile normally when it is not cancelled', async () => {
    installFetch(() => ({
      status: 'success',
      pdf_url: '/docs/doc-1/compile/job-1/pdf',
      synctex_url: null,
      error: null,
      warnings: ['Font not embedded: Foo'],
    }));
    const { result } = renderHook(() => useCompileLifecycle('doc-1', false));

    await act(async () => {
      await result.current.triggerCompile();
    });
    expect(result.current.compileState).toBe('success');
    expect(result.current.pdfUrl).toBe('/api/docs/doc-1/compile/job-1/pdf');
    expect(result.current.compileWarnings).toEqual(['Font not embedded: Foo']);
  });

  it('does not report a timeout for a compile whose route has gone away', async () => {
    const calls = installFetch(() => ({
      status: 'running',
      pdf_url: null,
      synctex_url: null,
      error: null,
    }));
    const { result, unmount } = renderHook(() => useCompileLifecycle('doc-1', false));
    let done = false;
    await act(async () => {
      void result.current.triggerCompile().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(100);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    // The promise settles promptly on abort instead of running out the
    // 60 s deadline, and no request was made past the unmount.
    expect(done).toBe(true);
    const lastGet = calls.filter((c) => c.method === 'GET').length;
    expect(lastGet).toBeLessThanOrEqual(2);
  });
});
