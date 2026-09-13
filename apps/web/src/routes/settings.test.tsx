import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { SettingsRoute } from './settings.js';
import { RouterProvider } from '../router.js';
import { AppThemeProvider } from '../lib/appearance.js';

vi.mock('../lib/session.js', () => ({
  useSession: () => ({
    status: 'authenticated' as const,
    user: {
      id: 'u1',
      email: 'ada@example.com',
      name: 'Ada',
      isAdmin: false,
      mustSetPassphrase: false,
    },
  }),
  refreshSession: vi.fn(),
}));

vi.mock('../components/TopBar.js', () => ({
  TopBar: () => <header data-testid="topbar-stub" />,
}));

afterEach(() => {
  cleanup();
});

describe('SettingsRoute — profile fields', () => {
  it('associates both profile labels with their inputs', () => {
    render(
      <AppThemeProvider>
        <RouterProvider>
          <SettingsRoute />
        </RouterProvider>
      </AppThemeProvider>,
    );
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    expect(email).toBe(screen.getByTestId('settings-email'));
    expect(email.value).toBe('ada@example.com');
    expect(screen.getByLabelText('Display name')).toBe(screen.getByTestId('settings-name'));
  });
});
