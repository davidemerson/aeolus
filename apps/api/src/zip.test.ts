import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildZip } from './zip.js';

describe('buildZip', () => {
  it('produces an archive that the system unzip can extract', () => {
    const zip = buildZip([
      { path: 'main.tex', data: Buffer.from('\\documentclass{article}\n', 'utf8') },
      { path: 'chapters/intro.tex', data: Buffer.from('Hello', 'utf8') },
      { path: 'images/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);

    const dir = mkdtempSync(path.join(tmpdir(), 'zip-test-'));
    try {
      const zipPath = path.join(dir, 'a.zip');
      writeFileSync(zipPath, zip);
      const out = path.join(dir, 'out');
      const r = spawnSync('unzip', ['-q', zipPath, '-d', out]);
      expect(r.status).toBe(0);
      const root = readdirSync(out).sort();
      expect(root).toEqual(['chapters', 'images', 'main.tex']);
      expect(readFileSync(path.join(out, 'main.tex'), 'utf8')).toBe('\\documentclass{article}\n');
      expect(readFileSync(path.join(out, 'chapters/intro.tex'), 'utf8')).toBe('Hello');
      expect(readFileSync(path.join(out, 'images/logo.png'))).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits an empty but valid archive when given no entries', () => {
    const zip = buildZip([]);
    // 22-byte EOCD only.
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
  });

  it('preserves binary bytes verbatim', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const zip = buildZip([{ path: 'all.bin', data: bytes }]);
    const dir = mkdtempSync(path.join(tmpdir(), 'zip-bin-'));
    try {
      const zipPath = path.join(dir, 'a.zip');
      writeFileSync(zipPath, zip);
      const out = path.join(dir, 'out');
      const r = spawnSync('unzip', ['-q', zipPath, '-d', out]);
      expect(r.status).toBe(0);
      expect(readFileSync(path.join(out, 'all.bin'))).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
