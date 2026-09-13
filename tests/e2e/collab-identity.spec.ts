import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

// #68 / ADR 0023: remote carets carry the collaborator's name and a
// per-person colour. Before this every remote caret was y-codemirror's
// default — one cyan "#30bced" labelled "Anonymous".
const DEFAULT_CYAN = 'rgb(48, 188, 237)';
// apps/web/src/lib/collab-colors.ts LIGHT_PALETTE, as the browser reports it.
// Kept in step by hand; collab-colors.test.ts guards the source values.
const LIGHT_PALETTE_RGB = [
  '#b3541e',
  '#a3711a',
  '#5f7d1f',
  '#1f8a6a',
  '#1f7fa6',
  '#4f62c2',
  '#8a4fb5',
  '#b5427a',
].map(
  (h) =>
    `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`,
);

async function signedInContext(
  browser: Browser,
  request: APIRequestContext,
  user: { email: string; name: string; isAdmin: boolean },
): Promise<{ context: BrowserContext; id: string }> {
  const create = await request.post('/api/dev/users', { data: user });
  expect(create.status(), `create ${user.name}`).toBe(201);
  const { id } = (await create.json()) as { id: string };
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const session = await context.request.post('/api/dev/sessions', { data: { userId: id } });
  expect(session.status(), `${user.name} dev session`).toBe(201);
  const state = await context.request.storageState();
  if (state.cookies.length > 0) await context.addCookies(state.cookies);
  return { context, id };
}

async function openDoc(page: Page, docId: string): Promise<void> {
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId('editor-host')).toBeVisible();
  await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
  await expect(page.getByTestId('compile-btn')).toHaveText('Compile', { timeout: 60_000 });
}

test.describe('collaborator identity', () => {
  test('each participant sees the other by name, in a distinct non-default colour', async ({
    browser,
    request,
  }) => {
    const alice = await signedInContext(browser, request, {
      email: 'alice-collab@example.com',
      name: 'Alice Author',
      isAdmin: true,
    });
    const bob = await signedInContext(browser, request, {
      email: 'bob-collab@example.com',
      name: 'Bob Builder',
      isAdmin: false,
    });

    try {
      const docCreate = await alice.context.request.post('/api/docs', {
        data: { title: 'Collab Identity', engine: 'latex' },
      });
      expect(docCreate.status(), 'create doc').toBe(201);
      const docId = ((await docCreate.json()) as { id: string }).id;
      const share = await alice.context.request.post(`/api/docs/${docId}/collaborators`, {
        data: { email: 'bob-collab@example.com', role: 'editor' },
      });
      expect(share.status(), 'share with bob').toBeLessThan(300);

      const alicePage = await alice.context.newPage();
      const bobPage = await bob.context.newPage();
      await openDoc(alicePage, docId);
      await openDoc(bobPage, docId);

      // A caret only appears remotely once the local tab has a selection.
      await alicePage.locator('.cm-content').click();
      await alicePage.keyboard.type('Alice was here. ');
      await bobPage.locator('.cm-content').click();
      await bobPage.keyboard.press('End');
      await bobPage.keyboard.type('Bob too.');

      // Bob sees Alice's caret, labelled with her name.
      const aliceCaretInBob = bobPage.locator('.cm-ySelectionCaret').first();
      await expect(aliceCaretInBob).toBeVisible({ timeout: 10_000 });
      await expect(aliceCaretInBob.locator('.cm-ySelectionInfo')).toHaveText('Alice Author');

      // Alice sees Bob's caret, labelled with his name.
      const bobCaretInAlice = alicePage.locator('.cm-ySelectionCaret').first();
      await expect(bobCaretInAlice).toBeVisible({ timeout: 10_000 });
      await expect(bobCaretInAlice.locator('.cm-ySelectionInfo')).toHaveText('Bob Builder');

      // Colours: drawn from the light palette (the E2E editor ground is
      // Solarized base3), never the library default. Two users CAN share a
      // slot (8 hues, ids are random uuids), so "differ" would be a 1-in-8
      // flake; palette membership is the deterministic claim.
      const aliceColor = await aliceCaretInBob.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      const bobColor = await bobCaretInAlice.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(aliceColor).not.toBe(DEFAULT_CYAN);
      expect(bobColor).not.toBe(DEFAULT_CYAN);
      expect(LIGHT_PALETTE_RGB).toContain(aliceColor);
      expect(LIGHT_PALETTE_RGB).toContain(bobColor);
    } finally {
      await alice.context.close();
      await bob.context.close();
    }
  });
});
