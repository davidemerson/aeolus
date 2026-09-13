import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TokensRoute } from './tokens.js';
import { RouterProvider } from '../router.js';

const useSession = vi.fn();
vi.mock('../lib/session.js', () => ({
  useSession: () => useSession(),
}));

vi.mock('../components/TopBar.js', () => ({
  TopBar: () => <header data-testid="topbar-stub" />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderRoute() {
  return render(
    <RouterProvider>
      <TokensRoute />
    </RouterProvider>,
  );
}

describe('TokensRoute', () => {
  it('shows the shared loading line while the session is unknown, not a blank page', () => {
    useSession.mockReturnValue({ status: 'loading' });
    const { container } = renderRoute();
    expect(container.textContent).toBe('Loading…');
  });

  it('labels the name field without nesting one label inside another', async () => {
    useSession.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'u1',
        email: 'ada@example.com',
        name: 'Ada',
        isAdmin: false,
        mustSetPassphrase: false,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ tokens: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    renderRoute();
    await waitFor(() => screen.getByText('No tokens yet. Nothing is calling the API with one.'));
    expect(screen.getByLabelText('What is it for?')).toBe(screen.getByTestId('token-name'));
    expect(screen.getByLabelText('Access')).toBe(screen.getByTestId('token-scope'));
    expect(document.querySelectorAll('label label')).toHaveLength(0);
  });

  it('revoke asks to confirm inline and only calls the API after confirm', async () => {
    useSession.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'u1',
        email: 'ada@example.com',
        name: 'Ada',
        isAdmin: false,
        mustSetPassphrase: false,
      },
    });
    const token = {
      id: 'tok_123',
      name: 'nightly-build',
      scope: 'write',
      created_by_email: 'ada@example.com',
      created_at: '2026-09-01T10:00:00Z',
      last_used_at: null,
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${u}`);
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({ tokens: calls.some((c) => c.startsWith('DELETE')) ? [] : [token] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    );
    renderRoute();
    const row = await waitFor(() => screen.getByTestId('token-row'));
    // The raw id is not part of the row text; it lives in the tooltip.
    expect(row.textContent).not.toContain('tok_123');
    expect(row.querySelector('[title="Token id tok_123"]')).toBeTruthy();

    fireEvent.click(screen.getByTestId('token-revoke-tok_123'));
    expect(screen.getByTestId('token-revoke-tok_123').textContent).toContain(
      'Revoke “nightly-build”?',
    );
    expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(0);

    fireEvent.click(screen.getByTestId('token-revoke-tok_123-cancel'));
    expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(0);

    fireEvent.click(screen.getByTestId('token-revoke-tok_123'));
    fireEvent.click(screen.getByTestId('token-revoke-tok_123-confirm'));
    await waitFor(() => {
      expect(calls).toContain('DELETE /api/tokens/tok_123');
    });
    await waitFor(() => screen.getByText('No tokens yet. Nothing is calling the API with one.'));
  });
});
