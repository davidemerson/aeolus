import { expect, test, type Browser, type BrowserContext } from '@playwright/test';

// Two affordances that existed in the API but not in the UI.
//
//  1. Engine picker on "New document". POST /api/docs has always taken
//     engine: 'latex' | 'typst', but the workspace button hardcoded
//     'latex' — and PATCH /api/docs/:id only changes the title, so the
//     engine is fixed for the life of the document. A blank Typst
//     document was therefore impossible to create: the only route to one
//     was forking a Typst template, which an admin had to author first.
//
//  2. A way INTO focus mode. setFocusMode(true) was reachable only from
//     the ⌘. keybinding and nothing in the UI mentioned it. The exit
//     button already existed, which is what hid the gap.

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function adminContext(
  browser: Browser,
  label: string,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: 'http://localhost:5173', viewport });
  // POST /api/docs is admin-only (non-admins fork templates), and the
  // engine picker only renders for admins for the same reason.
  const userCreate = await context.request.post('/api/dev/users', {
    data: { email: `${label}-${SUFFIX}@example.com`, name: label, isAdmin: true },
  });
  expect(userCreate.status(), 'create user').toBe(201);
  const user = (await userCreate.json()) as { id: string };
  const sessionRes = await context.request.post('/api/dev/sessions', {
    data: { userId: user.id },
  });
  expect(sessionRes.status(), 'create dev session').toBe(201);
  const apiState = await context.request.storageState();
  if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);
  return context;
}

test.describe('new-document engine picker', () => {
  test('creates a Typst document from the workspace, and LaTeX stays the default', async ({
    browser,
  }) => {
    const context = await adminContext(browser, 'engine-e2e');
    const page = await context.newPage();
    try {
      await page.goto('/docs');

      const picker = page.getByTestId('new-doc-engine');
      await expect(picker).toBeVisible();
      // LaTeX is preselected: the default path is unchanged for anyone
      // who does not care about the engine.
      await expect(page.getByTestId('new-doc-engine-latex')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByTestId('new-doc-engine-typst')).toHaveAttribute(
        'aria-pressed',
        'false',
      );

      // Pick Typst, create, and land in the editor.
      await page.getByTestId('new-doc-engine-typst').click();
      await expect(page.getByTestId('new-doc-engine-typst')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.getByTestId('new-doc').click();
      await page.waitForURL(/\/docs\/[0-9a-f-]{36}/);
      await expect(page.getByTestId('editor-host')).toBeVisible();

      // The engine badge beside the title is the user-visible proof.
      await expect(page.getByTestId('doc-title')).toBeVisible();
      const docId = /\/docs\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      expect(docId).not.toBe('');

      // ...and the persisted engine, which is what the compile worker
      // dispatches on.
      const docRes = await context.request.get(`/api/docs/${docId}`);
      expect(docRes.status()).toBe(200);
      const body = (await docRes.json()) as { doc: { engine: string } };
      expect(body.doc.engine).toBe('typst');

      // A typst project's entrypoint is main.typ, not main.tex.
      await page.getByTestId('files-toggle').click();
      await expect(page.getByTestId('file-tree-panel')).toContainText('main.typ');
    } finally {
      await context.close();
    }
  });

  test('still creates LaTeX when the picker is left alone', async ({ browser }) => {
    const context = await adminContext(browser, 'engine-default-e2e');
    const page = await context.newPage();
    try {
      await page.goto('/docs');
      await page.getByTestId('new-doc').click();
      await page.waitForURL(/\/docs\/[0-9a-f-]{36}/);
      const docId = /\/docs\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      const docRes = await context.request.get(`/api/docs/${docId}`);
      const body = (await docRes.json()) as { doc: { engine: string } };
      expect(body.doc.engine).toBe('latex');
    } finally {
      await context.close();
    }
  });
});

test.describe('focus mode', () => {
  test('is reachable from the toolbar and leaves on Esc', async ({ browser }) => {
    const context = await adminContext(browser, 'focus-e2e');
    const docCreateRes = await context.request.post('/api/docs', {
      data: { title: 'Focus Test', engine: 'latex' },
    });
    expect(docCreateRes.status(), 'create doc').toBe(201);
    const docId = ((await docCreateRes.json()) as { id: string }).id;
    const page = await context.newPage();
    try {
      await page.goto(`/docs/${docId}`);
      await expect(page.getByTestId('editor-host')).toBeVisible();

      // Chrome that focus mode hides is present to start with.
      await expect(page.getByTestId('status-bar')).toBeVisible();
      await expect(page.getByTestId('focus-mode-exit')).toHaveCount(0);

      // At this width the secondary actions sit inline, so the button
      // is directly on the toolbar.
      const enter = page.getByTestId('focus-mode-enter');
      await expect(enter).toBeVisible();
      await enter.click();

      // Focus mode: the exit affordance appears and the chrome goes.
      await expect(page.getByTestId('focus-mode-exit')).toBeVisible();
      await expect(page.getByTestId('status-bar')).toHaveCount(0);
      await expect(page.getByTestId('focus-mode-enter')).toHaveCount(0);
      // The editor itself must survive — hiding the panels must not
      // unmount CodeMirror.
      await expect(page.locator('.cm-content')).toBeVisible();

      // Esc leaves (the pre-existing keybinding).
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('focus-mode-exit')).toHaveCount(0);
      await expect(page.getByTestId('status-bar')).toBeVisible();
      await expect(page.getByTestId('focus-mode-enter')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('is inside the overflow menu at narrow widths', async ({ browser }) => {
    const context = await adminContext(browser, 'focus-narrow-e2e', {
      width: 900,
      height: 800,
    });
    const docCreateRes = await context.request.post('/api/docs', {
      data: { title: 'Focus Narrow', engine: 'latex' },
    });
    const docId = ((await docCreateRes.json()) as { id: string }).id;
    const page = await context.newPage();
    try {
      await page.goto(`/docs/${docId}`);
      await expect(page.getByTestId('editor-host')).toBeVisible();
      // Collapsed toolbar: the button must not vanish, it moves.
      await expect(page.getByTestId('focus-mode-enter')).toHaveCount(0);
      await page.getByTestId('toolbar-overflow').click();
      const panel = page.getByTestId('toolbar-overflow-panel');
      await expect(panel.getByTestId('focus-mode-enter')).toBeVisible();
      await panel.getByTestId('focus-mode-enter').click();
      await expect(page.getByTestId('focus-mode-exit')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
