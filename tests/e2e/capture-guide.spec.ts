import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

// Recaptures the screenshots the in-app guide shows. Not part of the normal
// suite — it asserts almost nothing and takes a while. Run it with:
//
//     node scripts/capture-guide-screenshots.mjs
//
// Everything it photographs is driven through the real app against a fresh
// database, with invented names. There is no mockup anywhere in here, and no
// real person's data, which is the rule: a guide that shows something the
// product does not do is worse than a guide with no pictures.
//
// Captured in the light theme deliberately. A guide teaches where things are,
// not what colour they are.

const OUT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../apps/web/public/guide',
);

const AUTHOR = { email: 'rowan@example.com', name: 'Rowan Fitzgerald' };
const REVIEWER = { email: 'imani@example.com', name: 'Imani Okonkwo' };

// Typst rather than LaTeX, so the compile actually produces a PDF on a
// machine with only Typst installed — the editor shot is supposed to show a
// document beside its output, not an error.
const SOURCE = `#import "preamble.typ": conf
#show: conf

= Tidal patterns in the Inner Sound

Readings were taken hourly at the north jetty over fourteen days. The
harmonic fit below uses the four principal constituents.

$ h(t) = H_0 + sum_(i=1)^4 A_i cos(omega_i t - phi.alt_i) $

== Results

The semi-diurnal constituent dominates, as expected for this coast. Spring
range at the jetty is 4.1 m; neaps run closer to 1.6 m.

== Method notes

Two gauges were used, cross-checked daily. The second was moved on the ninth
day after a boat fouled its mount, which is why days nine and ten carry a
wider error bar than the rest.
`;

const PREAMBLE = `#let conf(doc) = {
  set page(paper: "a4", margin: 2.4cm)
  set text(size: 11pt)
  set par(justify: true)
  doc
}
`;

test.skip(
  !process.env.AEOLUS_CAPTURE_GUIDE,
  'set AEOLUS_CAPTURE_GUIDE=1 to recapture the guide screenshots',
);

/**
 * One navigation, then clicks.
 *
 * Repeated `page.goto()` against the Vite dev server dies with
 * ERR_INSUFFICIENT_RESOURCES after a handful of loads — each one re-downloads
 * the whole unbundled module graph. Clicking is also what a reader does.
 */
async function shot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(400); // let transitions settle
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
  process.stdout.write(`[capture] ${name}.png\n`);
}

/** Press compile and wait for it to stop, however it ends. */
async function compile(page: Page): Promise<void> {
  await page.getByTestId('compile-btn').click();
  for (let i = 0; i < 120; i += 1) {
    const text = (await page.getByTestId('compile-status').textContent()) ?? '';
    if (!text.toLowerCase().includes('compil')) return;
    await page.waitForTimeout(1000);
  }
}

test('capture', async ({ browser, request }) => {
  test.setTimeout(10 * 60 * 1000);

  // Two people, so the collaborator surfaces have somebody in them.
  const author = await request
    .post('/api/dev/users', { data: { ...AUTHOR, isAdmin: true } })
    .then((r) => r.json() as Promise<{ id: string }>);
  await request.post('/api/dev/users', { data: { ...REVIEWER, isAdmin: false } });

  const context = await browser.newContext({
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const session = await context.request.post('/api/dev/sessions', { data: { userId: author.id } });
  expect(session.status()).toBe(201);
  const state = await context.request.storageState();
  if (state.cookies.length > 0) await context.addCookies(state.cookies);

  const page = await context.newPage();

  try {
    // The light theme, pinned before anything renders.
    await page.addInitScript(`document.cookie = 'aeolus_theme=light; path=/'`);

    await page.goto('/docs');
    await expect(page.getByTestId('topbar-user')).toHaveText(AUTHOR.name);

    // ---- a template, so the workspace has something to fork ----
    await page.getByRole('link', { name: /admin/i }).first().click();
    await page.waitForURL(/\/admin$/);
    await page
      .getByRole('link', { name: /templates/i })
      .first()
      .click();
    await page.waitForURL(/\/admin\/templates$/);
    await page.getByTestId('template-name-input').fill('Field report');
    await page
      .getByTestId('template-description-input')
      .fill('Sections, a figure and a bibliography, already laid out.');
    await page.getByTestId('template-engine').selectOption('typst');
    await page.getByTestId('template-create').click();
    await page.waitForTimeout(1500);
    // Publish it: a draft is invisible on the workspace, and the caption on
    // this shot is about the two states.
    await page
      .getByRole('button', { name: /^publish$/i })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(1200);
    await shot(page, 'admin-templates');

    // ---- the editor, with a document that actually compiles ----
    await page
      .getByRole('link', { name: /workspace|documents/i })
      .first()
      .click();
    await page.waitForURL(/\/docs$/);
    await page.getByTestId('new-doc-engine-typst').click();
    await page.getByTestId('new-doc').click();
    await page.waitForURL(/\/docs\/[0-9a-f-]+$/);
    await expect(page.getByTestId('editor-host')).toBeVisible();
    await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 30_000 });

    await page.getByTestId('doc-title-rename').click();
    await page.getByTestId('doc-title-input').fill('Tidal patterns in the Inner Sound');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // The preamble the main file imports. Made first, so the main file is
    // never in a state where its import points at nothing.
    await page.getByTestId('files-toggle').click();
    await expect(page.getByTestId('file-tree-panel')).toBeVisible();
    await page.getByTestId('file-tree-new-toggle').click();
    await page.getByTestId('file-tree-new-input').fill('preamble.typ');
    await page.getByTestId('file-tree-new-submit').click();
    await page.waitForTimeout(2000);
    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.type(PREAMBLE);
    await page.waitForTimeout(1500);
    await shot(page, 'file-tree');

    // Back to the main file, and the document itself.
    await page.getByText('main.typ', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(SOURCE);
    await page.waitForTimeout(1200);

    await compile(page);
    await page.waitForTimeout(3000);
    await page.getByTestId('files-toggle').click(); // close the tree for this one
    await page.waitForTimeout(600);
    await shot(page, 'editor');

    // ---- a real compile error, for the logs shot ----
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('#let broken = (1, 2\n');
    await compile(page);
    await page.waitForTimeout(1500);
    if ((await page.getByTestId('right-pane-tab-logs').count()) > 0) {
      await page.getByTestId('right-pane-tab-logs').click();
    }
    await page.waitForTimeout(1000);
    await shot(page, 'compile-logs');

    // Put it back so the rest of the shots show a document that compiles.
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(800);
    await compile(page);
    await page.waitForTimeout(2500);

    // ---- comments, anchored to a real selection ----
    await editor.click();
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    page.once('dialog', (d) => void d.accept('Which jetty? There are two, and they disagree.'));
    await page.getByTestId('comment-add-btn').click();
    await page.waitForTimeout(1500);
    if ((await page.getByTestId('comments-panel').count()) === 0) {
      await page.getByTestId('comments-toggle').click();
      await page.waitForTimeout(800);
    }
    await shot(page, 'comments');
    await page.getByTestId('comments-toggle').click();
    await page.waitForTimeout(500);

    // ---- version history ----
    await page.getByTestId('history-toggle').click();
    await expect(page.getByTestId('history-panel')).toBeVisible();
    await page.getByTestId('history-create-toggle').click();
    await page.getByTestId('history-label-input').fill('First full draft');
    await page.getByTestId('history-create-btn').click();
    await page.waitForTimeout(2000);
    await shot(page, 'history');
    await page.getByTestId('history-toggle').click();
    await page.waitForTimeout(500);

    // ---- the command palette ----
    await editor.click();
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'palette');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ---- focus mode ----
    await editor.click();
    await page.keyboard.press('ControlOrMeta+Shift+F');
    await page.waitForTimeout(1000);
    await shot(page, 'focus');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // ---- the workspace, now that there is something on it ----
    await page
      .getByRole('link', { name: /workspace|documents/i })
      .first()
      .click();
    await page.waitForURL(/\/docs$/);
    await expect(page.getByTestId('docs-list')).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, 'workspace');

    // ---- settings ----
    await page
      .getByRole('link', { name: /settings/i })
      .first()
      .click();
    await page.waitForURL(/\/settings$/);
    await page.waitForTimeout(600);
    await shot(page, 'settings');

    // ---- the remaining admin surfaces, last, so their tables have rows ----
    await page.getByRole('link', { name: /admin/i }).first().click();
    await page.waitForURL(/\/admin$/);
    await page.getByRole('link', { name: /users/i }).first().click();
    await page.waitForURL(/\/admin\/users$/);
    await expect(page.getByTestId('admin-users-table')).toBeVisible();
    await shot(page, 'admin-users');

    await page.goBack();
    await page.getByRole('link', { name: /audit/i }).first().click();
    await page.waitForURL(/\/admin\/audit$/);
    await page.waitForTimeout(1200);
    await shot(page, 'admin-audit');

    await page.goBack();
    await page
      .getByRole('link', { name: /diagnostics/i })
      .first()
      .click();
    await page.waitForURL(/\/admin\/diagnostics$/);
    // The page fires several probes; give them a beat rather than a race.
    await page.waitForTimeout(6000);
    await shot(page, 'admin-diagnostics');
  } finally {
    await context.close();
  }
});
