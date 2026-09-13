import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DocsListRoute } from './docs-list.js';
import { RouterProvider } from '../router.js';
import type { Template } from '../lib/api.js';

const useSession = vi.fn();
vi.mock('../lib/session.js', () => ({
  useSession: () => useSession(),
}));

vi.mock('../components/TopBar.js', () => ({
  TopBar: () => <header data-testid="topbar-stub" />,
}));

function user(isAdmin: boolean) {
  return {
    status: 'authenticated' as const,
    user: { id: 'u1', email: 'a@example.com', name: 'A', isAdmin, mustSetPassphrase: false },
  };
}

function template(id: string): Template {
  return {
    id,
    name: `Template ${id}`,
    description: null,
    engine: 'latex',
    is_published: true,
    yjs_doc_id: `y-${id}`,
    created_by: null,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };
}

function stubApi(templates: Template[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      const body = u.startsWith('/api/templates') ? { templates } : { docs: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function renderRoute() {
  return render(
    <RouterProvider>
      <DocsListRoute />
    </RouterProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/docs');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('DocsListRoute — empty workspace', () => {
  it('tells a non-admin that an administrator creates documents, without naming a hidden button', async () => {
    useSession.mockReturnValue(user(false));
    stubApi([]);
    renderRoute();
    await waitFor(() =>
      screen.getByText('No documents yet. An administrator can create one for you.'),
    );
    expect(screen.queryByTestId('new-doc')).toBeNull();
    expect(screen.queryByText('New document')).toBeNull();
  });

  it('points an admin at the New document button', async () => {
    useSession.mockReturnValue(user(true));
    stubApi([]);
    renderRoute();
    await waitFor(() => screen.getByText(/to create your first one/));
    expect(screen.getByTestId('new-doc')).toBeTruthy();
  });

  it('uses sentence case for the heading', async () => {
    useSession.mockReturnValue(user(false));
    stubApi([]);
    renderRoute();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Active documents');
  });
});

describe('DocsListRoute — templates count', () => {
  it('reads "1 template available" for one and pluralises otherwise', async () => {
    useSession.mockReturnValue(user(false));
    stubApi([template('t1')]);
    const { unmount } = renderRoute();
    await waitFor(() => screen.getByTestId('templates-count'));
    expect(screen.getByTestId('templates-count').textContent).toBe('1 template available');
    unmount();

    stubApi([template('t1'), template('t2'), template('t3')]);
    renderRoute();
    await waitFor(() => screen.getByTestId('templates-count'));
    expect(screen.getByTestId('templates-count').textContent).toBe('3 templates available');
  });
});

describe('DocsListRoute — engine picker', () => {
  it('is a pair of pressed buttons, LaTeX first, and switches on click', async () => {
    useSession.mockReturnValue(user(true));
    stubApi([]);
    renderRoute();
    await waitFor(() => screen.getByTestId('new-doc-engine'));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    const latex = screen.getByTestId('new-doc-engine-latex');
    const typst = screen.getByTestId('new-doc-engine-typst');
    expect(latex.getAttribute('aria-pressed')).toBe('true');
    expect(typst.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(typst);
    expect(typst.getAttribute('aria-pressed')).toBe('true');
    expect(latex.getAttribute('aria-pressed')).toBe('false');
  });

  it('spells the template engine as LaTeX, not LATEX', async () => {
    useSession.mockReturnValue(user(false));
    stubApi([template('t1')]);
    renderRoute();
    await waitFor(() => screen.getByTestId('templates-list'));
    expect(screen.getByText('LaTeX')).toBeTruthy();
  });
});
