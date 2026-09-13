import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '../../apps/electron');
const dirOutput = path.join(electronRoot, 'release', 'linux-unpacked');

if (existsSync(dirOutput)) {
  console.log(`Existing dir build found at ${dirOutput}, skipping rebuild.`);
} else {
  console.log('Running electron-builder --linux --dir ...');
  execFileSync(
    'pnpm',
    ['--filter', '@aeolus/electron', 'exec', 'electron-builder', '--linux', '--dir'],
    {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
}

const binary = path.join(dirOutput, 'aeolus');
if (!existsSync(binary)) {
  console.error(`Expected binary not found: ${binary}`);
  process.exit(1);
}

console.log(`Build smoke test passed — binary exists at ${binary}`);
