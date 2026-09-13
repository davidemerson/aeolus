import { expect, test } from '@playwright/test';

// The Tokens page (ADR 0020).
//
// The integration suite already covers the credential itself exhaustively.
// What only a browser can prove is the one-shot property as a USER experiences
// it: the plaintext is on screen once, and a reload does not bring it back.
// That is the whole safety story of a hash-at-rest credential, and it is the
// kind of thing a well-meaning refactor (caching the mint response, re-fetching
// on focus, persisting draft state) silently breaks with nothing failing.

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('API tokens', () => {
  test('shows a new token exactly once, then never again', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await context.newPage();
    try {
      const userCreate = await context.request.post('/api/dev/users', {
        data: { email: `tokens-${SUFFIX}@example.com`, name: 'Token User', isAdmin: false },
      });
      expect(userCreate.status()).toBe(201);
      const user = (await userCreate.json()) as { id: string };
      const sessionRes = await context.request.post('/api/dev/sessions', {
        data: { userId: user.id },
      });
      expect(sessionRes.status()).toBe(201);
      const apiState = await context.request.storageState();
      if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);

      // The affordance is in the header for any signed-in user, not behind
      // Admin — anyone who can sign in can mint their own.
      await page.goto('/docs');
      await expect(page.getByTestId('topbar-tokens')).toBeVisible();
      await page.getByTestId('topbar-tokens').click();
      await page.waitForURL(/\/tokens$/);

      await expect(page.getByText('No tokens yet.')).toBeVisible();

      await page.getByTestId('token-name').fill('e2e-nightly-build');
      await page.getByTestId('token-scope').selectOption('write');
      await page.getByTestId('token-create').click();

      // Shown once, in full, and it really is a token rather than a hash.
      const panel = page.getByTestId('tokens-plaintext');
      await expect(panel).toBeVisible();
      const shown = (await panel.locator('code').first().innerText()).trim();
      expect(shown).toMatch(/^aeolus_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);

      // It appears in the list, without its secret.
      const row = page.getByTestId('token-row').filter({ hasText: 'e2e-nightly-build' });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Read and write');
      await expect(page.getByTestId('tokens-table')).not.toContainText(shown);

      // The one that matters: reload and the plaintext is gone for good.
      await page.reload();
      await expect(
        page.getByTestId('token-row').filter({ hasText: 'e2e-nightly-build' }),
      ).toHaveCount(1);
      await expect(page.getByTestId('tokens-plaintext')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(shown);

      // And it actually authenticates the machine plane it was minted for.
      const me = await context.request.get('/api/v1/me', {
        headers: { authorization: `Bearer ${shown}` },
      });
      expect(me.status()).toBe(200);
      expect((await me.json()).user.id).toBe(user.id);

      // Revoke, confirm inline (no browser dialog — those are blocked when
      // the app is framed), and the row goes.
      await row.getByRole('button', { name: 'Revoke' }).click();
      await row.locator('[data-testid$="-confirm"]').click();
      await expect(
        page.getByTestId('token-row').filter({ hasText: 'e2e-nightly-build' }),
      ).toHaveCount(0);

      // Revocation is effective immediately, not on some cache expiry.
      const after = await context.request.get('/api/v1/me', {
        headers: { authorization: `Bearer ${shown}` },
      });
      expect(after.status()).toBe(401);
    } finally {
      await context.close();
    }
  });
});
