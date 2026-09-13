import { expect, test } from '@playwright/test';

const USER_EMAIL = 'ask-claude-fix-e2e@example.com';

// #57: "Ask Claude to fix" used to send the whole document and replace
// it wholesale on Accept. It now scopes the request to a window of
// paragraphs around the line the compile log names. This drives the
// real flow — real Tectonic error, real log parse — and asserts on the
// scope the panel declares and on the editor's actual selection. The
// Claude call itself needs no key here: the panel's scope line renders
// before the request, and the request failing (no ANTHROPIC_API_KEY in
// E2E) does not change what was selected.
test.describe('ask Claude to fix', () => {
  test('selects a window around the failing line, not the whole document', async ({
    browser,
    request,
  }) => {
    const userCreate = await request.post('/api/dev/users', {
      data: { email: USER_EMAIL, name: 'Fix User', isAdmin: true },
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

    const docCreateRes = await context.request.post('/api/docs', {
      data: { title: 'Ask Claude Fix', engine: 'latex' },
    });
    expect(docCreateRes.status(), 'create doc').toBe(201);
    const docId = ((await docCreateRes.json()) as { id: string }).id;

    // Fifteen three-line paragraphs (~60 lines), so the default 20-line
    // context window is a strict subset of the document. \hello (an
    // undefined control sequence) sits in paragraph 8; Tectonic reports
    // it as `l.<N> \hello`.
    const paragraphs: string[][] = [['\\documentclass{article}', '\\begin{document}']];
    for (let p = 1; p <= 15; p += 1) {
      paragraphs.push([
        `Para ${p} line a.`,
        p === 8 ? `Para ${p} \\hello line b.` : `Para ${p} line b.`,
        `Para ${p} line c.`,
      ]);
    }
    paragraphs.push(['\\end{document}']);
    const source = paragraphs.map((p) => p.join('\n')).join('\n\n');
    const totalLines = source.split('\n').length;
    const errorLine = source.split('\n').findIndex((l) => l.includes('\\hello')) + 1;

    const page = await context.newPage();
    try {
      await page.goto(`/docs/${docId}`);
      await expect(page.getByTestId('editor-host')).toBeVisible();
      await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });

      const compileBtn = page.getByTestId('compile-btn');
      await expect(compileBtn).toHaveText('Compile', { timeout: 60_000 });

      const editor = page.locator('.cm-content');
      await editor.click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.type(source, { delay: 5 });

      await compileBtn.click();
      // The editor switches the right pane to Logs on a failed compile.
      const askClaude = page.getByTestId('compile-ask-claude');
      await expect(askClaude).toBeVisible({ timeout: 60_000 });
      await askClaude.click();

      const scope = page.getByTestId('ai-scope');
      await expect(scope).toBeVisible();
      const label = (await scope.textContent()) ?? '';
      const m = /Fixing lines (\d+)–(\d+) of (\d+)/.exec(label);
      expect(m, `scope label was "${label}"`).not.toBeNull();
      const fromLine = Number(m![1]);
      const toLine = Number(m![2]);
      expect(Number(m![3])).toBe(totalLines);
      expect(fromLine).toBeLessThanOrEqual(errorLine);
      expect(toLine).toBeGreaterThanOrEqual(errorLine);
      // Paragraph-aligned window around the error, not the whole file:
      // the preamble and the closing paragraphs stay outside.
      expect(fromLine).toBeGreaterThan(3);
      expect(toLine).toBeLessThan(totalLines - 3);

      // The editor's selection is set by the same window (the label above is
      // derived from it), but the DOM selection is not observable here: the
      // editor has no drawSelection extension, so the native selection is
      // cleared the moment focus moves to the button. Accept-replaces-range is
      // the pre-existing handleAiAccept path and is covered by the rewrite
      // preset's tests.
    } finally {
      await context.close();
    }
  });
});
