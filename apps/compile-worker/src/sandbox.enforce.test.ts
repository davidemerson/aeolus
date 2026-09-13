/*
 * Real Landlock enforcement test for aeolus-sandbox.
 *
 * Unlike buildSandboxArgv's unit tests (which check the argv shape), this
 * compiles the C helper and asserts it actually confines a child: the workdir
 * is reachable, everything else — /etc/passwd, /proc/self/environ, writes
 * outside the workdir — is denied. This is the mechanism the whole fix rests
 * on, so it is worth proving directly.
 *
 * It needs a C compiler and a kernel with Landlock (>= 5.13). Where either is
 * missing (an old CI runner, a seccomp-restricted container) it skips LOUDLY
 * rather than passing vacuously — the authoritative proof is then the live
 * post-deploy probe recorded in ADR 0022.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../native/aeolus-sandbox.c', import.meta.url));

function tryCompile(): string | null {
  const cc = process.env.CC ?? 'cc';
  const out = join(mkdtempSync(join(tmpdir(), 'ern-sb-')), 'aeolus-sandbox');
  try {
    execFileSync(cc, ['-O2', '-Wall', '-Werror', '-o', out, SRC], { stdio: 'pipe' });
  } catch {
    return null; // no compiler / headers
  }
  // Does this kernel actually enforce? --probe reports it.
  try {
    const verdict = execFileSync(out, ['--probe'], { encoding: 'utf8' });
    if (!/landlock enforcing/.test(verdict)) return null; // present but unavailable
  } catch {
    return null;
  }
  return out;
}

const BIN = tryCompile();
const ready = BIN !== null;
if (!ready) {
  console.warn(
    '\n  [sandbox.enforce] SKIPPED — no C toolchain or Landlock unavailable on this ' +
      'kernel. The sandbox is proven instead by the live post-deploy probe (ADR 0022).\n',
  );
}

describe.skipIf(!ready)('aeolus-sandbox enforces Landlock confinement', () => {
  let workdir: string;
  const RO = [
    '--ro',
    '/usr',
    '--ro',
    '/lib',
    '--ro',
    '/lib64',
    '--ro',
    '/etc/ssl',
    '--ro',
    '/dev/urandom',
    '--ro',
    '/dev/null',
  ];

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'ern-wd-'));
    writeFileSync(join(workdir, 'main.tex'), 'hello from inside the workdir\n');
  });

  /** Run the helper wrapping a command; return {status, stdout, stderr}. */
  function sandboxed(mode: 'enforce' | 'audit', cmd: string[], rw = [workdir]) {
    const rwFlags = rw.flatMap((p) => ['--rw', p]);
    try {
      const stdout = execFileSync(BIN!, [...rwFlags, ...RO, '--mode', mode, '--', ...cmd], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer | string };
      return {
        status: e.status ?? -1,
        stdout: '',
        stderr: (e.stderr ?? '').toString(),
      };
    }
  }

  it('allows reading a file inside the rw workdir', () => {
    const r = sandboxed('enforce', ['cat', join(workdir, 'main.tex')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('hello from inside the workdir');
  });

  it('DENIES /etc/passwd — the exact traversal the vuln exploited', () => {
    const r = sandboxed('enforce', ['cat', '/etc/passwd']);
    expect(r.status).not.toBe(0);
  });

  it('DENIES /proc/self/environ — where the worker secrets would be', () => {
    const r = sandboxed('enforce', ['cat', '/proc/self/environ']);
    expect(r.status).not.toBe(0);
  });

  it('DENIES writing outside the workdir, and nothing lands there', () => {
    const escape = join(tmpdir(), `ern-escape-${Date.now()}`);
    const r = sandboxed('enforce', ['sh', '-c', `echo x > ${escape}`]);
    expect(r.status).not.toBe(0);
    expect(existsSync(escape)).toBe(false);
  });

  it('ALLOWS writing inside the workdir', () => {
    const r = sandboxed('enforce', ['sh', '-c', `echo pdf > ${join(workdir, 'out.pdf')}`]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(workdir, 'out.pdf'), 'utf8')).toBe('pdf\n');
  });

  it('rejects an unknown flag with a usage error (exit 64)', () => {
    const r = sandboxed('enforce', [], []); // no rw, but also inject a bad flag below
    // craft directly: a bogus flag
    try {
      execFileSync(BIN!, ['--nope', '--mode', 'enforce', '--', 'true'], { stdio: 'pipe' });
      expect.unreachable('should have exited non-zero');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(64);
    }
    void r;
  });

  it('refuses without a valid --mode (exit 64)', () => {
    try {
      execFileSync(BIN!, ['--rw', workdir, '--', 'true'], { stdio: 'pipe' });
      expect.unreachable('should have required --mode');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(64);
    }
  });

  afterAll(() => {
    // temp dirs are under the OS tmp; left for the OS to reap.
  });
});
