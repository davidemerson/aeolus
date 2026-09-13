import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { Link, RouterProvider, useRouter } from './router.js';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

// The Link component had a bug where `e.preventDefault()` was called
// before the user-supplied onClick had a chance to opt out, and
// navigate(to) was gated on `!e.defaultPrevented` — which after our
// own preventDefault is always false. Result: every Link in the SPA
// (Documents, Templates, brand title) was a dead anchor. Programmatic
// navigate() worked, which is why the bug hid until the user clicked
// a Link with no programmatic equivalent.
//
// These tests pin the corrected ordering so the regression cannot
// land again.
describe('Link', () => {
  it('SPA-navigates on a plain left-click', () => {
    window.history.replaceState({}, '', '/start');
    render(
      <RouterProvider>
        <Link to="/dest">go</Link>
      </RouterProvider>,
    );
    fireEvent.click(screen.getByText('go'), { button: 0 });
    expect(window.location.pathname).toBe('/dest');
  });

  it('skips SPA-nav on cmd-click so the browser opens a new tab', () => {
    // happy-dom follows the anchor href even on cmd-click (real
    // browsers open a new tab; happy-dom has no tab concept and just
    // updates window.location). To distinguish "we called navigate()"
    // from "the anchor default fired", spy on history.pushState —
    // navigate() goes through pushState; the anchor default does not.
    window.history.replaceState({}, '', '/start');
    const pushSpy = vi.spyOn(window.history, 'pushState');
    render(
      <RouterProvider>
        <Link to="/dest">go</Link>
      </RouterProvider>,
    );
    fireEvent.click(screen.getByText('go'), { button: 0, metaKey: true });
    expect(pushSpy).not.toHaveBeenCalled();
    pushSpy.mockRestore();
  });

  it('lets a custom onClick opt out via preventDefault', () => {
    window.history.replaceState({}, '', '/start');
    render(
      <RouterProvider>
        <Link
          to="/dest"
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          go
        </Link>
      </RouterProvider>,
    );
    fireEvent.click(screen.getByText('go'), { button: 0 });
    expect(window.location.pathname).toBe('/start');
  });

  it('updates RouterProvider state so dependent components re-render', () => {
    window.history.replaceState({}, '', '/start');
    function PathProbe() {
      const { path } = useRouter();
      return <div data-testid="probe">{path}</div>;
    }
    render(
      <RouterProvider>
        <Link to="/docs">docs</Link>
        <PathProbe />
      </RouterProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('/start');
    fireEvent.click(screen.getByText('docs'), { button: 0 });
    expect(screen.getByTestId('probe').textContent).toBe('/docs');
  });
});
