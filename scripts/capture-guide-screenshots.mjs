#!/usr/bin/env node
// Recaptures the screenshots the in-app guide shows.
//
//     node scripts/capture-guide-screenshots.mjs
//
// Boots the whole stack the way the end-to-end suite does — a throwaway
// Postgres, the api, the websocket process, the compile worker and the Vite
// dev server — drives the real app through every surface the guide points at,
// and writes the PNGs to apps/web/public/guide/. Commit what it produces.
//
// The work is in tests/e2e/capture-guide.spec.ts, which is skipped in the
// normal suite; this script is the wrapper that turns it on, so that the
// capture reuses the suite's stack rather than standing up a second one that
// could drift out of step with it.
//
// You need Docker (for the database), and Tectonic and Typst on your PATH if
// you want the compiled-PDF shots to show a PDF rather than an error.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const E2E_DIR = fileURLToPath(new URL('../tests/e2e', import.meta.url));

const result = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', 'capture-guide.spec.ts', '--reporter=list'],
  {
    cwd: E2E_DIR,
    stdio: 'inherit',
    env: { ...process.env, AEOLUS_CAPTURE_GUIDE: '1' },
  },
);

if (result.status !== 0) {
  process.stderr.write(
    '\ncapture-guide-screenshots: the run failed. The screenshots already in\n' +
      'apps/web/public/guide/ are unchanged; a partially captured set would be\n' +
      'worse than a stale one.\n',
  );
}

process.exit(result.status ?? 1);
