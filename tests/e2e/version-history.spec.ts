import { expect, test } from '@playwright/test';

const USER_EMAIL = 'history-e2e@example.com';

test.describe('version history', () => {
  test('creates checkpoints, edits destructively, restores from history', async ({
    browser,
    request,
  }) => {
    // Admin role because POST /api/docs is admin-only (PR #39 —
    // non-admins fork templates). The history flow itself is
    // role-agnostic; this test isn't about ACLs.
    const userCreate = await request.post('/api/dev/users', {
      data: { email: USER_EMAIL, name: 'History User', isAdmin: true },
    });
    expect(userCreate.status(), 'create user').toBe(201);
    const user = (await userCreate.json()) as { id: string };

    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });

    // Issue the session + create the doc via context.request —
    // NOT page.goto('/') + page.evaluate, which races
    // <HomeRedirect>'s navigate('/docs') and destroys the JS
    // context mid-call.
    const sessionRes = await context.request.post('/api/dev/sessions', {
      data: { userId: user.id },
    });
    expect(sessionRes.status(), 'create dev session').toBe(201);
    const apiState = await context.request.storageState();
    if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);

    const docCreateRes = await context.request.post('/api/docs', {
      data: { title: 'History Test', engine: 'latex' },
    });
    expect(docCreateRes.status(), 'create doc').toBe(201);
    const docId = ((await docCreateRes.json()) as { id: string }).id;

    const page = await context.newPage();

    // The checkpoint endpoint reads the document from what y-websocket has
    // persisted (loadDoc), not the in-memory room, so a checkpoint taken
    // before the flush lands captures stale text. download.zip renders text
    // files from that same persisted state and stores them uncompressed, so
    // polling it for the typed text is the condition the old fixed sleeps
    // stood in for.
    const waitForPersisted = async (text: string): Promise<void> => {
      await expect
        .poll(
          async () => {
            const res = await context.request.get(`/api/docs/${docId}/download.zip`);
            if (!res.ok()) return false;
            return (await res.body()).toString('utf8').includes(text);
          },
          { timeout: 15_000, message: `persisted source contains ${JSON.stringify(text)}` },
        )
        .toBe(true);
    };

    try {
      await page.goto(`/docs/${docId}`);
      await expect(page.getByTestId('editor-host')).toBeVisible();
      await expect(page.getByTestId('ws-status')).toHaveText('Connected', {
        timeout: 15_000,
      });

      // Type initial content, then wait until it is persisted server-side
      // (see waitForPersisted) before taking the checkpoint.
      const editor = page.locator('.cm-content');
      await editor.click();
      await page.keyboard.type('Version One content', { delay: 10 });
      await expect(editor).toContainText('Version One content');
      await waitForPersisted('Version One content');

      // Open History sidebar
      await page.getByTestId('history-toggle').click();
      await expect(page.getByTestId('history-panel')).toBeVisible();

      // Create checkpoint A. The `history-create-toggle` button is
      // labelled 'File' / 'Cancel' since per-file checkpoints
      // landed (PR #36); the testid is unchanged.
      await page.getByTestId('history-create-toggle').click();
      await expect(page.getByTestId('history-create-form')).toBeVisible();
      await page.getByTestId('history-label-input').fill('Checkpoint A');
      await page.getByTestId('history-create-btn').click();
      await expect(
        page.getByTestId('history-item').filter({ hasText: 'Checkpoint A' }),
      ).toBeVisible({ timeout: 10_000 });

      // Type more content
      await editor.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('Version Two content', { delay: 10 });
      await expect(editor).toContainText('Version Two content');
      await waitForPersisted('Version Two content');

      // Create checkpoint B
      await page.getByTestId('history-create-toggle').click();
      await expect(page.getByTestId('history-create-form')).toBeVisible();
      await page.getByTestId('history-label-input').fill('Checkpoint B');
      await page.getByTestId('history-create-btn').click();
      await expect(
        page.getByTestId('history-item').filter({ hasText: 'Checkpoint B' }),
      ).toBeVisible({ timeout: 10_000 });

      // Destructive edit
      await editor.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('destructive edit', { delay: 10 });
      await expect(editor).toContainText('destructive edit');
      await expect(editor).not.toContainText('Version Two content');

      // Open Checkpoint A's preview. Match by label rather than
      // position because PR #36 added auto-open checkpoints — the
      // list can contain auto_open entries that shift `.last()`.
      const cpAItem = page
        .getByTestId('history-item')
        .filter({ hasText: 'Checkpoint A' })
        .getByTestId('history-item-btn');
      await cpAItem.click();
      await expect(page.getByTestId('checkpoint-preview')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-testid="checkpoint-preview"] pre')).toContainText(
        'Version One content',
      );

      // Restore checkpoint A
      await page.getByTestId('checkpoint-restore-btn').click();
      await page.getByTestId('checkpoint-restore-confirm').click();

      // Wait for restore to complete and preview to close
      await expect(page.getByTestId('checkpoint-preview')).not.toBeVisible({ timeout: 10_000 });

      // Verify the editor shows the restored content once the restore
      // has propagated through the live session.
      await expect(editor).toContainText('Version One content', { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});
