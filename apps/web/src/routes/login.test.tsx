import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LoginRoute } from './login.js';
import { RouterProvider } from '../router.js';
import { ApiRequestError } from '../lib/api.js';

const post = vi.fn();
const refreshSession = vi.fn(async () => ({ status: 'anonymous' as const }));
const useSession = vi.fn(() => ({ status: 'anonymous' }) as { status: string });
const navigate = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api.js')>()),
  api: { post: (path: string, body?: unknown) => post(path, body) },
}));

vi.mock('../lib/session.js', () => ({
  useSession: () => useSession(),
  refreshSession: () => refreshSession(),
}));

vi.mock('../router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../router.js')>();
  return { ...actual, useRouter: () => ({ ...actual.useRouter(), navigate }) };
});

function renderLogin() {
  return render(
    <RouterProvider>
      <LoginRoute />
    </RouterProvider>,
  );
}

function fillAndSubmit(email = 'ada@example.com', passphrase = 'correct horse battery staple') {
  fireEvent.change(screen.getByTestId('login-email'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('login-passphrase'), { target: { value: passphrase } });
  fireEvent.submit(screen.getByTestId('login-form'));
}

beforeEach(() => {
  useSession.mockReturnValue({ status: 'anonymous' });
  post.mockResolvedValue({
    user: { id: 'u1', email: 'ada@example.com', name: 'Ada', is_admin: false },
    must_set_passphrase: false,
  });
  window.history.replaceState({}, '', '/login');
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.clearAllMocks();
});

describe('LoginRoute', () => {
  it('posts the credential and lands on /docs', async () => {
    renderLogin();
    fillAndSubmit();

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/auth/login', {
      email: 'ada@example.com',
      passphrase: 'correct horse battery staple',
    });
    // The session cache is re-read before navigating, so /docs renders for a
    // signed-in user instead of bouncing back through the 401 handler.
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith('/docs', { replace: true });
  });

  it('sends a user who is still on a generated credential to setup', async () => {
    post.mockResolvedValue({
      user: { id: 'u1', email: 'ada@example.com', name: 'Ada', is_admin: false },
      must_set_passphrase: true,
    });
    renderLogin();
    fillAndSubmit();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/passphrase', { replace: true }));
  });

  it("shows the server's sentence on a refusal and stays put", async () => {
    post.mockRejectedValue(
      new ApiRequestError(401, 'invalid_credentials', 'That email and passphrase do not match.'),
    );
    renderLogin();
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByTestId('login-error').textContent).toBe(
        'That email and passphrase do not match.',
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
    // Still submittable: a typo must not need a reload to correct.
    expect((screen.getByTestId('login-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('redirects an already-authenticated visitor away from the form', async () => {
    useSession.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'u1',
        email: 'ada@example.com',
        name: 'Ada',
        isAdmin: false,
        mustSetPassphrase: false,
      },
    } as never);
    renderLogin();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/docs', { replace: true }));
  });
});
