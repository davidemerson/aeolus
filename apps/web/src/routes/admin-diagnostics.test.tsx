import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toastStore } from '@aeolus/shared/ui';

import { AdminDiagnosticsRoute } from './admin-diagnostics.js';
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

const SNAPSHOT = {
  ts: '2026-09-13T14:05:00Z',
  queue: { queue: 'compile', total_jobs: 3, jobs_in_last_hour: 1, oldest_unfinished_seconds: null },
  compiles: {
    recent_total: 1,
    by_status: { success: 1 },
    oldest_queued_seconds: null,
    most_recent: [],
  },
  compile_boss_attached: true,
};

function renderRoute() {
  return render(
    <RouterProvider>
      <AdminDiagnosticsRoute />
    </RouterProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/admin/diagnostics');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const item of [...toastStore.items]) toastStore.dismiss(item.id);
  window.history.replaceState({}, '', '/');
});

describe('AdminDiagnosticsRoute — snapshot failure', () => {
  it('replaces Loading… with the error and a Retry that fetches again', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return new Response(null, { status: 502 });
        return new Response(JSON.stringify(SNAPSHOT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderRoute();
    const card = await waitFor(() => screen.getByTestId('diag-snapshot-error'));
    expect(card.textContent).toContain('The request could not be completed.');
    expect(screen.queryByText('Loading…')).toBeNull();

    fireEvent.click(screen.getByTestId('diag-retry'));
    await waitFor(() => screen.getByTestId('diag-refresh'));
    expect(attempts).toBe(2);
    expect(screen.queryByTestId('diag-snapshot-error')).toBeNull();
    expect(screen.getByText(/snapshot at 13 Sep 2026/)).toBeTruthy();
  });
});
