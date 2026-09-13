import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { HomeRedirect } from './App.js';
import { RouterProvider } from './router.js';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('HomeRedirect', () => {
  it('replace-navigates to /docs from an effect (not during render)', () => {
    window.history.replaceState({}, '', '/');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouterProvider>
        <HomeRedirect />
      </RouterProvider>,
    );
    // useEffect fires after the synchronous render, so by the time
    // render() returns we should already see the replaceState call.
    // Critically: no React "setState during render" warnings.
    expect(window.location.pathname).toBe('/docs');
    expect(replaceSpy).toHaveBeenCalled();
    const setStateWarnings = errSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('setState')),
    );
    expect(setStateWarnings).toEqual([]);
  });
});
