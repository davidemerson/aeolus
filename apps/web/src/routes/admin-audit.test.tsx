import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AdminAuditRoute } from './admin-audit.js';
import { RouterProvider } from '../router.js';

vi.mock('../lib/session.js', () => ({
  useSession: () => ({
    status: 'authenticated' as const,
    user: {
      id: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      isAdmin: true,
      mustSetPassphrase: false,
    },
  }),
}));

vi.mock('../components/TopBar.js', () => ({
  TopBar: () => <header data-testid="topbar-stub" />,
}));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const EMPTY = { events: [], next_before: null, retention_days: 90 };

function renderRoute() {
  return render(
    <RouterProvider>
      <AdminAuditRoute />
    </RouterProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/admin/audit');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('AdminAuditRoute — loading and empty states', () => {
  it('shows Loading… until the first page answers, then the plain empty state', async () => {
    const first = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => first.promise),
    );
    renderRoute();
    expect(screen.getByTestId('audit-loading').textContent).toBe('Loading…');
    expect(screen.queryByTestId('audit-empty')).toBeNull();

    first.resolve(json(EMPTY));
    const empty = await waitFor(() => screen.getByTestId('audit-empty'));
    expect(empty.textContent).toBe('No events to show.');
  });

  it('names the active action filter when it hides everything', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        urls.push(typeof url === 'string' ? url : url.toString());
        return json(EMPTY);
      }),
    );
    renderRoute();
    await waitFor(() => screen.getByTestId('audit-empty'));

    fireEvent.change(screen.getByTestId('audit-filter'), { target: { value: 'template.' } });
    await waitFor(() => {
      expect(urls.some((u) => u.includes('action=template.'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-empty').textContent).toBe(
        'No events under “Templates” in this period. Pick “All actions” to widen the search.',
      );
    });
  });

  it('shows "not signed in" for an event with no actor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          events: [
            {
              id: 'e1',
              occurred_at: '2026-09-13T14:05:00Z',
              actor_id: null,
              actor_email: null,
              action: 'auth.login_failed',
              resource_type: null,
              resource_id: null,
              metadata: {},
              ip: '10.0.0.1',
              user_agent: null,
            },
          ],
          next_before: null,
          retention_days: 90,
        }),
      ),
    );
    renderRoute();
    const row = await waitFor(() => screen.getByTestId('audit-row-e1'));
    expect(row.textContent).toContain('not signed in');
    expect(row.textContent).not.toContain('unauth');
  });
});
