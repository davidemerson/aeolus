import { describe, expect, it } from 'vitest';

import { buildSandboxArgv, buildTectonicArgs, conventionMirrorRels } from './runner.js';

describe('buildTectonicArgs', () => {
  // Default (no bundle override) — matches the pre-issue-#11 shape:
  // -X compile --outdir <workdir> --outfmt pdf <source>.
  it('emits the canonical args without --bundle when tectonicBundle is unset', () => {
    expect(buildTectonicArgs({ workdir: '/tmp/work', sourceName: 'main.tex' })).toEqual([
      '-X',
      'compile',
      '--synctex',
      '--outdir',
      '/tmp/work',
      '--outfmt',
      'pdf',
      'main.tex',
    ]);
  });

  // Issue #11: when AEOLUS_TECTONIC_BUNDLE is plumbed through, we
  // pass --bundle <value> to tectonic so it skips the public
  // relay. Position matters — Tectonic 0.15 wants the flag before
  // the source filename.
  it('inserts --bundle before --outdir when tectonicBundle is set', () => {
    const args = buildTectonicArgs({
      workdir: '/tmp/work',
      sourceName: 'main.tex',
      tectonicBundle: 'https://bucket.s3.us-east-1.amazonaws.com/tectonic-bundle/v0_3.tar',
    });
    expect(args).toEqual([
      '-X',
      'compile',
      '--bundle',
      'https://bucket.s3.us-east-1.amazonaws.com/tectonic-bundle/v0_3.tar',
      '--synctex',
      '--outdir',
      '/tmp/work',
      '--outfmt',
      'pdf',
      'main.tex',
    ]);
  });

  it('omits --bundle when tectonicBundle is empty string', () => {
    // The runbook explicitly says clearing the env reverts to the
    // public relay — empty string must NOT pass through as
    // `--bundle ''`.
    const args = buildTectonicArgs({
      workdir: '/w',
      sourceName: 'main.tex',
      tectonicBundle: '',
    });
    expect(args).not.toContain('--bundle');
  });
});

describe('conventionMirrorRels', () => {
  const none = new Set<string>();

  it('mirrors a bare root font into fonts/ and a bare image into images/', () => {
    expect(conventionMirrorRels('X.ttf', 'X.ttf', none)).toEqual(['fonts/X.ttf']);
    expect(conventionMirrorRels('logo.png', 'logo.png', none)).toEqual(['images/logo.png']);
  });

  it('never mirrors a file that already lives in a folder', () => {
    expect(conventionMirrorRels('figures/x.png', 'x.png', none)).toEqual([]);
    expect(conventionMirrorRels('fonts/X.ttf', 'X.ttf', none)).toEqual([]);
  });

  // #82: a root-level `X.ttf` next to an explicit `fonts/X.ttf` row
  // used to write the same workdir path from two concurrent asset
  // writes — which bytes a compile used was a race. The explicit
  // asset wins, deterministically: the mirror is suppressed.
  it('suppresses a mirror whose target path another asset explicitly claims', () => {
    const explicit = new Set(['fonts/Some Custom Face.ttf', 'main.tex']);
    expect(conventionMirrorRels('Some Custom Face.ttf', 'Some Custom Face.ttf', explicit)).toEqual(
      [],
    );
    // A different filename still mirrors normally.
    expect(conventionMirrorRels('Other.ttf', 'Other.ttf', explicit)).toEqual(['fonts/Other.ttf']);
  });
});

describe('buildSandboxArgv', () => {
  const sandbox = { bin: '/usr/local/bin/aeolus-sandbox', mode: 'enforce' as const };

  it('grants rw on the workdir and ro on the engine, with the mode and a -- terminator', () => {
    const argv = buildSandboxArgv(sandbox, {
      engineBin: '/usr/local/bin/tectonic',
      workdir: '/tmp/work',
    });
    expect(argv[0]).toBe('/usr/local/bin/aeolus-sandbox');
    expect(argv[argv.indexOf('--rw') + 1]).toBe('/tmp/work');
    expect(argv.slice(argv.indexOf('--ro'))).toContain('/usr/local/bin/tectonic');
    expect(argv.slice(-3)).toEqual(['--mode', 'enforce', '--']);
  });

  it('adds the cache dir as a second rw path only when present', () => {
    const withCache = buildSandboxArgv(sandbox, {
      engineBin: '/usr/local/bin/tectonic',
      workdir: '/tmp/work',
      cacheDir: '/opt/tectonic-cache',
    });
    const rwPaths = withCache
      .map((a, i) => (a === '--rw' ? withCache[i + 1] : null))
      .filter(Boolean);
    expect(rwPaths).toEqual(['/tmp/work', '/opt/tectonic-cache']);

    const noCache = buildSandboxArgv(sandbox, {
      engineBin: '/usr/local/bin/tectonic',
      workdir: '/tmp/work',
    });
    expect(noCache.filter((a) => a === '--rw')).toHaveLength(1);
  });

  it('never lets a system path become writable (only --ro)', () => {
    const argv = buildSandboxArgv(sandbox, {
      engineBin: '/usr/local/bin/typst',
      workdir: '/tmp/work',
      cacheDir: '/opt/cache',
    });
    for (const sys of ['/usr', '/etc/ssl', '/etc/fonts', '/dev/urandom']) {
      const idx = argv.indexOf(sys);
      expect(idx).toBeGreaterThan(0);
      expect(argv[idx - 1]).toBe('--ro');
    }
  });
});
