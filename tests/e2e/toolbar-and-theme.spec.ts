import { expect, test } from '@playwright/test';

const USER_EMAIL = `toolbar-e2e-${Date.now()}@example.com`;

test.describe('doc editor toolbar + theme picker', () => {
  test('overflow menu appears at narrow widths and surfaces secondary actions; archive button is gone', async ({
    browser,
    request,
  }) => {
    // Admin role because POST /api/docs is admin-only (PR #39 —
    // non-admins fork templates). The toolbar surface itself is
    // role-agnostic.
    const userCreate = await request.post('/api/dev/users', {
      data: { email: USER_EMAIL, name: 'Toolbar User', isAdmin: true },
    });
    expect(userCreate.status(), 'create user').toBe(201);
    const user = (await userCreate.json()) as { id: string };

    // Use a narrow viewport so the (max-width: 1024px) media query
    // engages and the toolbar collapses into the overflow menu.
    const context = await browser.newContext({
      baseURL: 'http://localhost:5173',
      viewport: { width: 900, height: 800 },
    });

    // Issue session + create doc via context.request, NOT
    // page.goto('/') + page.evaluate (the home route's
    // <HomeRedirect> destroys the JS context mid-call).
    const sessionRes = await context.request.post('/api/dev/sessions', {
      data: { userId: user.id },
    });
    expect(sessionRes.status(), 'create dev session').toBe(201);
    const apiState = await context.request.storageState();
    if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);

    const docCreateRes = await context.request.post('/api/docs', {
      data: { title: 'Toolbar Test', engine: 'latex' },
    });
    expect(docCreateRes.status(), 'create doc').toBe(201);
    const docId = ((await docCreateRes.json()) as { id: string }).id;

    const page = await context.newPage();

    try {
      await page.goto(`/docs/${docId}`);
      await expect(page.getByTestId('editor-host')).toBeVisible();

      // The Archive button is gone (#5).
      await expect(page.getByTestId('archive-btn')).toHaveCount(0);
      // The theme toggle is gone (#6).
      await expect(page.getByTestId('theme-toggle')).toHaveCount(0);

      // The overflow trigger is present at this width; secondary
      // actions are inside it (closed by default).
      const overflow = page.getByTestId('toolbar-overflow');
      await expect(overflow).toBeVisible();
      await expect(page.getByTestId('toolbar-overflow-panel')).toHaveCount(0);

      await overflow.click();
      const panel = page.getByTestId('toolbar-overflow-panel');
      await expect(panel).toBeVisible();
      // The Claude button (#4) and the checkmark-style PDF
      // toggle (#3) live inside the menu.
      await expect(panel.getByTestId('ai-btn')).toBeVisible();
      await expect(panel.getByTestId('ai-btn')).toHaveText(/claude/i);
      await expect(panel.getByTestId('pdf-toggle')).toBeVisible();
      // Pdf is shown by default — the label includes the ✓ marker.
      await expect(panel.getByTestId('pdf-toggle')).toContainText('✓');

      // Click outside closes the menu.
      await page.getByTestId('files-toggle').click();
      await expect(page.getByTestId('toolbar-overflow-panel')).toHaveCount(0);

      // Resize wide — secondary actions render inline; menu disappears.
      await page.setViewportSize({ width: 1400, height: 900 });
      await expect(page.getByTestId('toolbar-overflow')).toHaveCount(0);
      await expect(page.getByTestId('ai-btn')).toBeVisible();
      await expect(page.getByTestId('pdf-toggle')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('editor theme picker on /settings persists the user choice', async ({
    browser,
    request,
  }) => {
    const email = `theme-e2e-${Date.now()}@example.com`;
    const userCreate = await request.post('/api/dev/users', {
      data: { email, name: 'Theme User', isAdmin: false },
    });
    expect(userCreate.status(), 'create user').toBe(201);
    const user = (await userCreate.json()) as { id: string };

    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });

    // Issue session via context.request (not page.evaluate after
    // page.goto('/'); see the comment in the first test).
    const sessionRes = await context.request.post('/api/dev/sessions', {
      data: { userId: user.id },
    });
    expect(sessionRes.status(), 'create dev session').toBe(201);
    const apiState = await context.request.storageState();
    if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);

    const page = await context.newPage();
    await page.goto('/settings');
    await expect(page.getByTestId('editor-theme-section')).toBeVisible();

    // Default is `auto` — follow the app — as of 2026-08-12. It used to be
    // solarized-dark, which made the editor a permanently-dark island inside a
    // permanently-light shell. This assertion is the behaviour change: a fresh
    // user with empty localStorage lands on auto, not on a pinned variant.
    await expect(page.getByTestId('editor-theme-auto')).toHaveAttribute('aria-pressed', 'true');
    for (const t of ['dark', 'light']) {
      await expect(page.getByTestId(`editor-theme-${t}`)).toHaveAttribute('aria-pressed', 'false');
    }

    // Pick light. The pressed state flips and localStorage persists.
    await page.getByTestId('editor-theme-light').click();
    await expect(page.getByTestId('editor-theme-light')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('editor-theme-auto')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => localStorage.getItem('aeolus.editor.theme'))).toBe(
      'solarized-light',
    );

    // Reload — selection survives. This is the half that matters for the
    // behaviour change: anyone who HAS pinned a variant keeps it.
    await page.reload();
    await expect(page.getByTestId('editor-theme-light')).toHaveAttribute('aria-pressed', 'true');

    // And back to auto, which must write the literal 'auto' rather than
    // clearing the key — a cleared key is indistinguishable from a fresh user,
    // which is fine today but would silently re-pin if the default ever moved.
    await page.getByTestId('editor-theme-auto').click();
    await expect(page.getByTestId('editor-theme-auto')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('aeolus.editor.theme'))).toBe('auto');

    await context.close();
  });

  test('appearance control cycles auto -> light -> dark and persists', async ({
    browser,
    request,
  }) => {
    const email = `appearance-e2e-${Date.now()}@example.com`;
    const userCreate = await request.post('/api/dev/users', {
      data: { email, name: 'Appearance User', isAdmin: false },
    });
    expect(userCreate.status(), 'create user').toBe(201);
    const user = (await userCreate.json()) as { id: string };

    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const sessionRes = await context.request.post('/api/dev/sessions', {
      data: { userId: user.id },
    });
    expect(sessionRes.status(), 'create dev session').toBe(201);
    const apiState = await context.request.storageState();
    if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);

    const page = await context.newPage();
    await page.goto('/docs');

    const control = page.getByRole('button', { name: /^Appearance:/ });
    await expect(control).toBeVisible();

    // auto is the default, and auto is the ABSENCE of data-theme — a literal
    // data-theme="auto" would match no cascade block and pin the app to light.
    await expect(control).toHaveAttribute('aria-label', 'Appearance: auto');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(
      false,
    );

    for (const next of ['light', 'dark'] as const) {
      await control.click();
      await expect(control).toHaveAttribute('aria-label', `Appearance: ${next}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', next);
      // The cookie is what the server reads to stamp the shell, so the instant
      // toggle and the next page load cannot disagree.
      const cookies = await context.cookies();
      expect(cookies.find((c) => c.name === 'aeolus_theme')?.value).toBe(next);
    }

    // A third click returns to auto and removes the attribute again.
    await control.click();
    await expect(control).toHaveAttribute('aria-label', 'Appearance: auto');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(
      false,
    );

    // Reload: the server stamps data-theme from the cookie, so an explicit
    // choice is applied before the SPA mounts rather than after.
    await control.click(); // -> light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(control).toHaveAttribute('aria-label', 'Appearance: light');

    await context.close();
  });
});
