import { writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const USER_EMAIL = 'compile-e2e@example.com';

test.describe('compile and preview', () => {
  test('types LaTeX, compiles, sees PDF canvas, uploads asset', async ({ browser, request }) => {
    // Admin role because POST /api/docs is admin-only (PR #39 —
    // non-admins fork templates). The compile flow itself is
    // role-agnostic; this test isn't about ACLs.
    const userCreate = await request.post('/api/dev/users', {
      data: { email: USER_EMAIL, name: 'Compile User', isAdmin: true },
    });
    expect(userCreate.status(), 'create user').toBe(201);
    const user = (await userCreate.json()) as { id: string };

    const context = await browser.newContext({ baseURL: 'http://localhost:5173' });

    // Issue the session + create the doc via the shared `request`
    // fixture — NOT via `page.goto('/') + page.evaluate`, which
    // races against <HomeRedirect>'s navigate('/docs') and
    // destroys the JS execution context mid-call.
    const sessionRes = await context.request.post('/api/dev/sessions', {
      data: { userId: user.id },
    });
    expect(sessionRes.status(), 'create dev session').toBe(201);
    const apiState = await context.request.storageState();
    if (apiState.cookies.length > 0) await context.addCookies(apiState.cookies);

    const docCreateRes = await context.request.post('/api/docs', {
      data: { title: 'Compile Test', engine: 'latex' },
    });
    expect(docCreateRes.status(), 'create doc').toBe(201);
    const docId = ((await docCreateRes.json()) as { id: string }).id;

    const page = await context.newPage();

    try {
      await page.goto(`/docs/${docId}`);
      await expect(page.getByTestId('editor-host')).toBeVisible();
      await expect(page.getByTestId('ws-status')).toHaveText('Connected', {
        timeout: 15_000,
      });

      const LATEX_SOURCE = [
        '\\documentclass{article}',
        '\\begin{document}',
        'Hello compile test!',
        '\\end{document}',
      ].join('\n');

      const editor = page.locator('.cm-content');
      await editor.click();

      // Compile-on-open fires automatically when the editor loads
      // an empty doc. Wait for the button to leave its 'Compiling…'
      // state before driving the explicit compile flow below.
      const compileBtn = page.getByTestId('compile-btn');
      await expect(compileBtn).toHaveText('Compile', { timeout: 60_000 });

      await page.keyboard.press('Meta+A');
      await page.keyboard.type(LATEX_SOURCE, { delay: 10 });

      await compileBtn.click();

      // Compile-status renders as a chevron prefix + lowercase
      // status word: "›compiling…" / "›compiled · pdf ready" /
      // "›ready · save to compile" / "›<error>" — see
      // doc-editor.tsx ~line 1394. Use toContainText so the
      // chevron prefix and the trailing dotted phrasing don't
      // need to be reproduced exactly.
      await expect(page.getByTestId('compile-status')).toContainText('compiling', {
        timeout: 3_000,
      });

      await expect(page.getByTestId('compile-status')).toContainText('compiled', {
        timeout: 60_000,
      });

      // The 'compiled' status only means the PDF is ready to fetch — the
      // canvas then requires the whole PDF-viewer cold-start: React.lazy()
      // pulls the ~500 KB pdfjs-dist chunk, pdf.js spins up its web worker, and
      // getDocument() fetches + parses + rasterises page 1. Under a loaded CI
      // runner in Vite *dev* mode (on-demand transpile of the lazy chunk) that
      // bootstrap routinely exceeds 10s — this is the same first-render path
      // that compile (60s) and ws-connect (15s) above are already generous for.
      // 10s was the odd one out and is what makes this test flake. 30s matches
      // the rest of the flow.
      await expect(page.getByTestId('pdf-canvas')).toBeVisible({ timeout: 30_000 });
      const canvas = page.getByTestId('pdf-canvas');
      const box = await canvas.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThan(10);
      expect(box!.height).toBeGreaterThan(10);

      // The legacy Assets panel was a redundant flat-list view of
      // the same doc_files data the FileTreePanel renders. It was
      // dropped — assets and source live together in the Files
      // tree now (see ADR 0013 and the migration to doc_files).
      // Single-file uploads go through the new "↑ file" affordance
      // on the file tree's header.
      await page.getByTestId('files-toggle').click();
      await expect(page.getByTestId('file-tree-panel')).toBeVisible();

      const png1x1 = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      );
      const tmpPath = '/tmp/e2e-test-image.png';
      writeFileSync(tmpPath, png1x1);

      // The single-file input is hidden behind the "↑ file" button
      // for normal users; the test sets files on the input directly,
      // which matches Playwright's standard file-upload pattern.
      const fileInput = page.getByTestId('file-tree-file-input');
      await fileInput.setInputFiles(tmpPath);

      const uploaded = page.getByTestId('file-tree-file-e2e-test-image.png');
      await expect(uploaded).toBeVisible({ timeout: 10_000 });
      await expect(uploaded).toContainText('e2e-test-image.png');
    } finally {
      await context.close();
    }
  });
});
