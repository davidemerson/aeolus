#!/usr/bin/env node
// Drives a real first run against a running compose stack.
//
//     docker compose up -d
//     node scripts/compose-smoke.mjs
//
// This is the test that answers "does the README work". It uses only what a
// person has on a fresh install: the running containers, a browser, and the
// api's log. Nothing is seeded, no test-only endpoint is called, and the
// passphrase is read out of the log exactly the way the instructions say to
// read it.
//
// What it proves, in order:
//   1. The stack answers on one port.
//   2. The first launch created an administrator and printed a credential.
//   3. That credential signs in, and lands in forced passphrase setup.
//   4. A weak passphrase is refused; a real one is accepted.
//   5. A document can be created and typed into.
//   6. It compiles with Typst and produces a PDF that downloads.
//   7. A second browser session sees the edit, which means the websocket,
//      the shared blob store and the database are all actually wired up.
//
// Screenshots of each stage land in .compose-smoke/ so a CI failure can be
// looked at rather than guessed at.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const BASE_URL = process.env.AEOLUS_BASE_URL ?? 'http://localhost:8080';
const SHOTS = join(fileURLToPath(new URL('..', import.meta.url)), '.compose-smoke');
const CHOSEN_PASSPHRASE = 'thicket lantern rowboat cobble sundial';

mkdirSync(SHOTS, { recursive: true });

let step = 0;
async function shot(page, name) {
  step += 1;
  await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`) });
}

function say(message) {
  process.stdout.write(`[smoke] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[smoke] FAILED: ${message}\n`);
  process.exit(1);
}

/**
 * The generated credential, from the api's log. The README tells a person to
 * run this exact command, so if the format changes this notices.
 */
function bootstrapCredential() {
  const logs = execFileSync('docker', ['compose', 'logs', 'api'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const email = /email:\s+(\S+)/.exec(logs);
  const passphrase = /passphrase:\s+(.+)/.exec(logs);
  if (!email || !passphrase) {
    process.stderr.write(logs.slice(-4000));
    fail('the api never printed a first-launch credential');
  }
  return { email: email[1].trim(), passphrase: passphrase[1].trim() };
}

const TYPST_SOURCE = [
  '#set page(width: 12cm, height: 8cm, margin: 1cm)',
  '#set text(size: 14pt)',
  '= Compiled by the smoke test',
  '',
  'If this reads as a PDF, the queue, the worker and the blob store all work.',
  '',
].join('\n');

async function main() {
  const credential = bootstrapCredential();
  say(`first-launch account: ${credential.email}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE_URL, acceptDownloads: true });
  const page = await context.newPage();

  try {
    // 1 + 2. Sign in with what the installer printed.
    await page.goto('/login');
    await shot(page, 'login');
    await page.getByTestId('login-email').fill(credential.email);
    await page.getByTestId('login-passphrase').fill(credential.passphrase);
    await page.getByTestId('login-submit').click();

    // 3. Forced setup, with no "current passphrase" field: the sign-in just
    //    proved it.
    await page.waitForURL(/\/passphrase$/, { timeout: 20_000 });
    await shot(page, 'forced-setup');
    if ((await page.getByTestId('passphrase-current').count()) !== 0) {
      fail('forced setup asked for the current passphrase');
    }

    // 4. A weak one is refused.
    await page.getByTestId('passphrase-next').fill('password');
    await page.getByTestId('passphrase-confirm').fill('password');
    await page.getByTestId('passphrase-submit').click();
    await page.getByTestId('passphrase-problems').waitFor({ timeout: 10_000 });
    if (new URL(page.url()).pathname !== '/passphrase') {
      fail('a weak passphrase was accepted');
    }
    await shot(page, 'weak-refused');

    await page.getByTestId('passphrase-next').fill(CHOSEN_PASSPHRASE);
    await page.getByTestId('passphrase-confirm').fill(CHOSEN_PASSPHRASE);
    await page.getByTestId('passphrase-submit').click();
    await page.waitForURL(/\/docs$/, { timeout: 20_000 });
    say('signed in and past setup');
    await shot(page, 'workspace');

    // 5. A Typst document, and a live editing session on it. Typst rather
    //    than LaTeX because Tectonic downloads a large TeX bundle on first
    //    use, and a smoke test should not depend on that; Typst is
    //    self-contained in the image. The engine is fixed at creation, so it
    //    has to be chosen before the button.
    await page.getByTestId('new-doc-engine-typst').click();
    await page.getByTestId('new-doc').click();
    await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 20_000 });
    const docUrl = page.url();
    await page.getByTestId('editor-host').waitFor({ timeout: 20_000 });
    await page.getByTestId('ws-status').filter({ hasText: 'Connected' }).waitFor({
      timeout: 30_000,
    });
    say('websocket connected');

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.type(TYPST_SOURCE);
    await shot(page, 'typed');

    // 6. Compile, and download what comes out.
    const compileStatus = page.getByTestId('compile-status');
    await page.getByTestId('compile-btn').click();
    // Poll the status line rather than racing a transition: the first compile
    // of a fresh instance also warms the worker.
    let status = '';
    for (let i = 0; i < 180; i += 1) {
      status = (await compileStatus.textContent()) ?? '';
      if (!status.toLowerCase().includes('compil')) break;
      await page.waitForTimeout(1000);
    }
    if (/fail|error/i.test(status)) fail(`compile reported: ${status.trim()}`);
    await shot(page, 'compiled');

    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByTestId('download-pdf-btn').click(),
    ]).then(([d]) => d);
    const pdfPath = join(SHOTS, 'compiled.pdf');
    await download.saveAs(pdfPath);
    const head = execFileSync('head', ['-c', '5', pdfPath], { encoding: 'latin1' });
    if (!head.startsWith('%PDF-'))
      fail(`the download is not a PDF (starts ${JSON.stringify(head)})`);
    say('compiled a PDF and downloaded it');

    // 7. A second session, signing in from scratch with the chosen
    //    passphrase, sees the same text. This is the end-to-end proof: the
    //    edit went through the websocket, was persisted, and came back.
    const second = await browser.newContext({ baseURL: BASE_URL });
    const secondPage = await second.newPage();
    await secondPage.goto('/login');
    await secondPage.getByTestId('login-email').fill(credential.email);
    await secondPage.getByTestId('login-passphrase').fill(CHOSEN_PASSPHRASE);
    await secondPage.getByTestId('login-submit').click();
    await secondPage.waitForURL(/\/docs$/, { timeout: 20_000 });
    await secondPage.goto(docUrl);
    await secondPage.getByTestId('ws-status').filter({ hasText: 'Connected' }).waitFor({
      timeout: 30_000,
    });
    await secondPage
      .locator('.cm-content')
      .filter({ hasText: 'Compiled by the smoke test' })
      .waitFor({ timeout: 20_000 });
    await shot(secondPage, 'second-session');
    say('a second session sees the edit');
    await second.close();

    writeFileSync(join(SHOTS, 'result.txt'), 'ok\n');
    say('everything the README promises works');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
