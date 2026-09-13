import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PassphraseRoute } from './passphrase.js';
import { RouterProvider } from '../router.js';
import { ApiRequestError } from '../lib/api.js';

const get = vi.fn();
const post = vi.fn();
const refreshSession = vi.fn(async () => ({ status: 'anonymous' as const }));
const useSession = vi.fn();
const navigate = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

vi.mock('../lib/session.js', () => ({
  useSession: () => useSession(),
  refreshSession: () => refreshSession(),
}));

vi.mock('../router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../router.js')>();
  return { ...actual, useRouter: () => ({ ...actual.useRouter(), navigate }) };
});

function session(mustSetPassphrase: boolean) {
  return {
    status: 'authenticated',
    user: { id: 'u1', email: 'ada@example.com', name: 'Ada', isAdmin: false, mustSetPassphrase },
  };
}

function renderRoute() {
  return render(
    <RouterProvider>
      <PassphraseRoute />
    </RouterProvider>,
  );
}

function fill(next: string, confirm = next) {
  fireEvent.change(screen.getByTestId('passphrase-next'), { target: { value: next } });
  fireEvent.change(screen.getByTestId('passphrase-confirm'), { target: { value: confirm } });
}

beforeEach(() => {
  useSession.mockReturnValue(session(true));
  get.mockResolvedValue({
    rule: 'At least 16 characters.',
    suggestion: 'six random words here now',
  });
  post.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PassphraseRoute — forced setup', () => {
  it('omits the current-passphrase field and posts only the new one', async () => {
    renderRoute();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/auth/policy'));
    expect(screen.queryByTestId('passphrase-current')).toBeNull();

    fill('a long enough passphrase for the policy');
    fireEvent.submit(screen.getByTestId('passphrase-form'));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/auth/passphrase', {
        next: 'a long enough passphrase for the policy',
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/docs', { replace: true }));
  });

  it('offers the generated suggestion and fills both fields with it', async () => {
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId('passphrase-suggestion').textContent).toBe(
        'six random words here now',
      ),
    );
    fireEvent.click(screen.getByTestId('passphrase-use-suggestion'));
    expect((screen.getByTestId('passphrase-next') as HTMLInputElement).value).toBe(
      'six random words here now',
    );
    expect((screen.getByTestId('passphrase-confirm') as HTMLInputElement).value).toBe(
      'six random words here now',
    );
  });

  it('refuses a mismatch without asking the server', async () => {
    renderRoute();
    fill('one long passphrase here', 'a different one entirely');
    fireEvent.submit(screen.getByTestId('passphrase-form'));

    await waitFor(() =>
      expect(screen.getByTestId('passphrase-problems').textContent).toContain('do not match'),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('lists every reason the server gave, not just the first', async () => {
    post.mockRejectedValue(
      new ApiRequestError(422, 'weak_passphrase', 'Too short.', {
        problems: ['Too short.', 'That is a very common passphrase.'],
      }),
    );
    renderRoute();
    fill('password');
    fireEvent.submit(screen.getByTestId('passphrase-form'));

    await waitFor(() => {
      const items = screen.getByTestId('passphrase-problems').querySelectorAll('li');
      expect(Array.from(items).map((li) => li.textContent)).toEqual([
        'Too short.',
        'That is a very common passphrase.',
      ]);
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('PassphraseRoute — voluntary change', () => {
  it('requires the current passphrase and sends it', async () => {
    useSession.mockReturnValue(session(false));
    renderRoute();

    fireEvent.change(screen.getByTestId('passphrase-current'), {
      target: { value: 'the old one that still works' },
    });
    fill('a brand new passphrase of length');
    fireEvent.submit(screen.getByTestId('passphrase-form'));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/auth/passphrase', {
        current: 'the old one that still works',
        next: 'a brand new passphrase of length',
      }),
    );
  });
});
