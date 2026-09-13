import { expect, test } from '@playwright/test';

// The in-app Guide.
//
// Three things the unit tests cannot check: that the header affordance is on
// every page including signed out, that a deep link into a subsection works
// from a cold navigation, and — the one that actually bites — that every
// screenshot the guide references is really served. A committed <img> whose
// file is missing renders a broken image in the middle of the page, and
// nothing in a diff or a typecheck notices.

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('the guide', () => {
  test('is reachable from the header on every page, signed in and out', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await context.newPage();
    try {
      // Signed out: a lost user is often on /login, which is exactly where the
      // guide has to be reachable from.
      // /login renders no TopBar by design (a bare centred sign-in card), so
      // it carries its own quiet link. The affordance is what matters, not
      // which component provides it.
      await page.goto('/login');
      await expect(page.getByTestId('login-guide')).toBeVisible();
      await page.getByTestId('login-guide').click();
      await page.waitForURL(/\/guide$/);
      await expect(
        page.getByRole('heading', { name: 'Overview & mental model' }).first(),
      ).toBeVisible();

      // Signed in: still there, on the workspace and on the settings page.
      const userCreate = await context.request.post('/api/dev/users', {
        data: { email: `guide-${SUFFIX}@example.com`, name: 'Guide User', isAdmin: true },
      });
      expect(userCreate.status()).toBe(201);
      const user = (await userCreate.json()) as { id: string };
      const sessionRes = await context.request.post('/api/dev/sessions', {
        data: { userId: user.id },
      });
      expect(sessionRes.status()).toBe(201);
      const apiState = await context.request.storageState();
      if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);

      for (const path of ['/docs', '/settings', '/admin']) {
        await page.goto(path);
        await expect(page.getByTestId('topbar-guide')).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });

  test('deep-links into a subsection and moves between them', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await context.newPage();
    try {
      // A cold navigation straight to a subsection — what an error message or a
      // bookmark would do.
      await page.goto('/guide/compiling');
      await expect(
        page.getByRole('heading', { name: 'Compiling & the PDF' }).first(),
      ).toBeVisible();

      // The prev/next pager moves to a real neighbouring section.
      await page
        .getByRole('link', { name: /Collaboration/ })
        .first()
        .click();
      await page.waitForURL(/\/guide\/collaboration$/);
      await expect(page.getByRole('heading', { name: 'Collaboration' }).first()).toBeVisible();

      // An unknown slug falls back rather than 404ing or blanking.
      await page.goto('/guide/no-such-section');
      await expect(
        page.getByRole('heading', { name: 'Overview & mental model' }).first(),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('every screenshot it references is actually served', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await context.newPage();
    try {
      // ONE full navigation, then move by clicking the table of contents.
      // Ten `page.goto`s in a row exhaust the renderer against the vite dev
      // server (ERR_INSUFFICIENT_RESOURCES) because each one re-downloads the
      // whole unbundled module graph. Clicking is also what a reader does.
      await page.goto('/guide/overview');
      const toc = page.locator('aside');

      const sections: [string, string][] = [
        ['overview', 'Overview & mental model'],
        ['templates', 'Templates'],
        ['files', 'Files & the file tree'],
        ['compiling', 'Compiling & the PDF'],
        ['comments', 'Comments'],
        ['history', 'History & restoring'],
        ['claude', 'Claude'],
        ['focus', 'Focus mode'],
        ['settings', 'Your settings'],
        ['admin', 'Admin surfaces'],
      ];

      const seen = new Set<string>();
      for (const [slug, title] of sections) {
        if (slug !== 'overview') {
          await toc.getByRole('link', { name: title, exact: true }).click();
          await page.waitForURL(new RegExp(`/guide/${slug}$`));
        }
        await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();
        const srcs = await page
          .locator('article img')
          .evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src') ?? ''));
        for (const src of srcs) seen.add(src);
      }
      expect(seen.size).toBeGreaterThan(8);

      for (const src of seen) {
        const res = await context.request.get(src);
        expect(res.status(), `${src} should be served`).toBe(200);
        expect(res.headers()['content-type'], `${src} should be a png`).toContain('image/png');
        // A zero-byte or truncated file would still 200. Any real screenshot of
        // this app is far bigger than 5 KB.
        expect((await res.body()).byteLength, `${src} should not be empty`).toBeGreaterThan(5_000);
      }
    } finally {
      await context.close();
    }
  });

  // The standard is explicit that guide screenshots carry invented data only.
  // A real address in a committed asset is the failure mode worth a test: it is
  // invisible in a diff and permanent in git history.
  test('names no real mailbox in its prose', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await context.newPage();
    try {
      await page.goto('/guide/overview');
      const toc = page.locator('aside');
      const sections: [string, string][] = [
        ['overview', 'Overview & mental model'],
        ['signing-in', 'Signing in'],
        ['admin', 'Admin surfaces'],
        ['troubleshooting', 'Troubleshooting / FAQ'],
        ['claude', 'Claude'],
      ];
      for (const [slug, title] of sections) {
        if (slug !== 'overview') {
          await toc.getByRole('link', { name: title, exact: true }).click();
          await page.waitForURL(new RegExp(`/guide/${slug}$`));
        }
        await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();
        const text = (await page.locator('article').textContent()) ?? '';
        const addresses = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
        for (const a of addresses) {
          // example.com and .example are the reserved forms; anything else in
          // guide prose is someone's real inbox.
          expect(
            /@example\.com$|\.example$/.test(a),
            `guide/${slug} names a non-reserved address: ${a}`,
          ).toBe(true);
        }
      }
    } finally {
      await context.close();
    }
  });
});
