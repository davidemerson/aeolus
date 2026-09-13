import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const electronRoot = path.resolve(import.meta.dirname, '../../apps/electron');
const appImage = path.join(electronRoot, 'release', `Aeolus-0.0.1-x86_64.AppImage`);
const unpackedBinary = path.join(electronRoot, 'release', 'linux-unpacked', 'aeolus');

function findBinary(): string | null {
  if (existsSync(unpackedBinary)) return unpackedBinary;
  if (existsSync(appImage)) return appImage;
  return null;
}

// Smoke test against a pre-built Electron binary. Skipped when no
// build artifact is present (lint/typecheck/test workflow doesn't
// run electron-builder); the dedicated Build Electron workflow runs
// the build first and exercises this path.
const builtBinary = findBinary();

describe('Electron boot smoke test', () => {
  it.skipIf(builtBinary === null)(
    'packaged binary boots and exits cleanly with --headless-test',
    () => {
      const binary = builtBinary as string;
      const result = execFileSync(binary, ['--headless-test', '--no-sandbox'], {
        timeout: 30_000,
        env: {
          ...process.env,
          AEOLUS_APP_URL: 'data:text/html,<h1>Aeolus</h1>',
          DISPLAY: process.env['DISPLAY'] ?? ':99',
        },
      });

      expect(result).toBeDefined();
    },
  );
});
