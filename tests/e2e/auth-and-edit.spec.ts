import { expect, test } from '@playwright/test';

const ALICE_EMAIL = 'alice@example.com';

test.describe('auth and edit', () => {
  test('a signed-in user creates and edits a document', async ({ browser, request }) => {
    // 1. Seed Alice via the dev endpoints. Admin role: per PR #39
    //    non-admins can't create docs from scratch (they fork
    //    templates instead). This test exercises the create-doc →
    //    edit flow, which only admins reach today.
    const aliceCreate = await request.post('/api/dev/users', {
      data: { email: ALICE_EMAIL, name: 'Alice', isAdmin: true },
    });
    expect(aliceCreate.status(), 'create alice').toBe(201);
    const alice = (await aliceCreate.json()) as { id: string; email: string };

    // 2. Alice context — issue a session cookie via /dev/sessions. The real
    //    sign-in path (email + passphrase, and the setup it forces) has its
    //    own spec in first-run.spec.ts; this one is about editing, so it
    //    takes the short way in.
    const aliceContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const aliceSession = await aliceContext.request.post('/api/dev/sessions', {
      data: { userId: alice.id },
    });
    expect(aliceSession.status(), 'alice dev session').toBe(201);

    // Transfer cookies from the API request context to the browser context.
    const apiState = await aliceContext.request.storageState();
    if (apiState.cookies.length > 0) {
      await aliceContext.addCookies(apiState.cookies);
    }

    const alicePage = await aliceContext.newPage();

    try {
      // 3. Alice lands in /docs when authenticated.
      await alicePage.goto('/docs');
      await expect(alicePage.getByTestId('topbar-user')).toHaveText('Alice');
      await expect(alicePage.getByTestId('topbar-user')).toHaveAttribute('title', ALICE_EMAIL);

      // 4. New document.
      await alicePage.getByTestId('new-doc').click();
      await alicePage.waitForURL(/\/docs\/[0-9a-f-]+$/);
      await expect(alicePage.getByTestId('editor-host')).toBeVisible();
      await expect(alicePage.getByTestId('ws-status')).toHaveText('Connected', {
        timeout: 15_000,
      });

      // 5. Type in the editor.
      const docUrl = alicePage.url();
      const editor = alicePage.locator('.cm-content');
      await editor.click();
      await alicePage.keyboard.type('Hello, world');
      await expect(alicePage.locator('.cm-content')).toContainText('Hello, world');

      // 5a. Soft-wrap is active (EditorView.lineWrapping). Type a
      //     long whitespace-separated paragraph that comfortably
      //     overflows the editor pane and verify (a) CodeMirror's
      //     wrapping class is on the content node and (b) the line
      //     element actually wraps onto multiple visual rows
      //     (height > one line) without producing horizontal
      //     scrollbars on the scroller.
      const longLine = 'The quick brown fox jumps over the lazy dog '.repeat(12).trim();
      await alicePage.keyboard.press('End');
      await alicePage.keyboard.press('Enter');
      await alicePage.keyboard.type(longLine);
      await expect(editor).toHaveClass(/cm-lineWrapping/);
      const wrapMetrics = await alicePage.evaluate(() => {
        const scroller = document.querySelector('.cm-scroller');
        const lines = document.querySelectorAll('.cm-line');
        const last = lines[lines.length - 1] as HTMLElement | undefined;
        if (!scroller || !last) return null;
        return {
          lineHeight: last.getBoundingClientRect().height,
          scrollWidth: scroller.scrollWidth,
          clientWidth: scroller.clientWidth,
        };
      });
      expect(wrapMetrics, 'editor wrap metrics').not.toBeNull();
      // A wrapped paragraph spans at least two visual rows (~32px
      // at the default font-size); a non-wrapping editor would keep
      // it on one row and overflow horizontally instead.
      expect(wrapMetrics!.lineHeight).toBeGreaterThan(30);
      expect(wrapMetrics!.scrollWidth).toBeLessThanOrEqual(wrapMetrics!.clientWidth + 1);

      // Compile-on-open already fired at mount on an empty doc;
      // wait for it to settle, then trigger an explicit compile via
      // Cmd+S so the session-token rotation tied to /compile doesn't
      // race with the second tab's /me call.
      //
      // 90s, not 30s: this spec sorts first, so this is the FIRST
      // compile of the whole suite — on a cold TECTONIC_CACHE_DIR
      // (a bundle-cache key miss in CI) tectonic downloads the full
      // package bundle from the public relay before compiling, and
      // that alone was measured blowing a 30s budget on GitHub
      // runners (the recurring auth-and-edit flake, 2026-08-28..31).
      // The post-edit compile below keeps the tight 30s budget —
      // by then the bundle is warm and 30s is a real regression.
      const compileStatus = alicePage.getByTestId('compile-status');
      await expect(compileStatus).not.toContainText('compiling', { timeout: 90_000 });
      await alicePage.keyboard.press('Meta+S');
      await expect(compileStatus).toContainText('compiling', { timeout: 5_000 });
      await expect(compileStatus).not.toContainText('compiling', { timeout: 30_000 });

      // 6. Second tab in the same context opens the doc and must converge.
      const aliceTab2 = await aliceContext.newPage();
      await aliceTab2.goto(docUrl);
      await expect(aliceTab2.getByTestId('ws-status')).toHaveText('Connected', {
        timeout: 15_000,
      });
      await expect(aliceTab2.locator('.cm-content')).toContainText('Hello, world', {
        timeout: 5_000,
      });
      await aliceTab2.close();
    } finally {
      await aliceContext.close();
    }
  });
});
