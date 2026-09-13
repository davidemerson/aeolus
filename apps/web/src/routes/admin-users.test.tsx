import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toastStore } from '@aeolus/shared/ui';

import { AdminUsersRoute } from './admin-users.js';
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

const ROW = {
  id: 'u2',
  email: 'bob@example.com',
  name: 'Bob',
  is_admin: false,
  disabled_at: null,
  last_seen_at: null,
  created_at: '2026-05-01T00:00:00Z',
};

interface Call {
  url: string;
  method: string;
}

function stubApi(users: unknown[], onMutate: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      if (method === 'GET' && u === '/api/admin/users') {
        return new Response(JSON.stringify({ users }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return onMutate();
    }),
  );
  return calls;
}

function renderRoute() {
  return render(
    <RouterProvider>
      <AdminUsersRoute />
    </RouterProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/admin/users');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const item of [...toastStore.items]) toastStore.dismiss(item.id);
  window.history.replaceState({}, '', '/');
});

describe('AdminUsersRoute — failed requests surface', () => {
  it('a failed disable shows the server sentence in an error toast', async () => {
    const calls = stubApi(
      [ROW],
      () =>
        new Response(
          JSON.stringify({
            error: 'self_disable',
            message: 'You cannot disable your own account.',
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    );
    renderRoute();
    const disable = await waitFor(() => screen.getByRole('button', { name: 'Disable' }));
    fireEvent.click(disable);
    await waitFor(() => {
      expect(toastStore.items.map((t) => [t.kind, t.message])).toEqual([
        ['error', 'You cannot disable your own account.'],
      ]);
    });
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/admin/users/u2/disable');
    // The row is usable again after the failure.
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Disable' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  it('a delete that fails without a body still reports a sentence', async () => {
    stubApi([ROW], () => new Response(null, { status: 502 }));
    renderRoute();
    fireEvent.click(await waitFor(() => screen.getByTestId('admin-user-delete-u2')));
    fireEvent.click(screen.getByTestId('admin-user-delete-u2-confirm'));
    await waitFor(() => {
      expect(toastStore.items).toHaveLength(1);
    });
    const [toast] = toastStore.items;
    expect(toast.kind).toBe('error');
    expect(toast.message).toMatch(/^[A-Z].*\.$/);
    expect(toast.message).not.toMatch(/\b50\d\b|Bad Gateway/);
  });
});

describe('AdminUsersRoute — filter and empty states', () => {
  it('labels the filter field', async () => {
    stubApi([ROW], () => new Response(null, { status: 204 }));
    renderRoute();
    await waitFor(() => screen.getByTestId('admin-users-table'));
    expect(screen.getByLabelText('Filter users')).toBe(screen.getByTestId('admin-users-filter'));
  });

  it('says "No users yet." when there is nothing to filter, and "No users match." once a filter is typed', async () => {
    stubApi([], () => new Response(null, { status: 204 }));
    renderRoute();
    await waitFor(() => screen.getByTestId('admin-users-empty'));
    expect(screen.getByTestId('admin-users-empty').textContent).toBe('No users yet.');

    fireEvent.change(screen.getByLabelText('Filter users'), { target: { value: 'zed' } });
    expect(screen.getByTestId('admin-users-empty').textContent).toBe('No users match.');
  });
});
