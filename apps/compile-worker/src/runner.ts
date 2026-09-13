import { spawn } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fontEmbeddingWarnings } from './pdf-fonts.js';
import { parseSynctex, type SynctexMap } from './synctex.js';

export interface AssetFile {
  // Project-relative materialization path. May contain forward
  // slashes (e.g. 'images/logo.png'); parent directories are
  // created with mkdir -p semantics. Convention mirroring to
  // fonts/ and images/ only applies when the path is a bare
  // filename (no slash) so a user who already organised their
  // project into folders gets exactly that layout in the workdir.
  path: string;
  // Display name (basename of `path`). Kept for log lines and
  // fontconfig configuration; derived from `path` when not set.
  filename: string;
  data: Buffer;
}

/**
 * Confine the engine's filesystem with `aeolus-sandbox` (Landlock) before exec.
 * When unset, the engine is spawned directly — identical to pre-sandbox
 * behaviour, which is why every test that omits it is unchanged.
 *   audit   — attempt to apply, log the verdict, run regardless.
 *   enforce — apply or fail closed (the engine never runs unconfined).
 * See docs/DECISIONS/0022-sandbox-compile-engine-with-landlock.md.
 */
export interface SandboxConfig {
  bin: string;
  mode: 'audit' | 'enforce';
}

export interface CompileRunOptions {
  engine: 'latex' | 'typst';
  source: string;
  sandbox?: SandboxConfig;
  tectonicBin: string;
  typstBin: string;
  tectonicCacheDir?: string;
  // Optional override for the Tectonic bundle source. When set,
  // passed through to `tectonic -X compile --bundle <value>`.
  // Accepts an HTTPS URL (S3 presigned, public mirror, or anything
  // tectonic can fetch) or a local file path. Issue #11.
  tectonicBundle?: string;
  timeoutMs?: number;
  workdirBase?: string;
  assets?: AssetFile[];
}

export interface CompileRunResult {
  pdf: Buffer;
  stdout: string;
  stderr: string;
  // Parsed synctex map. Present only for the LaTeX engine (Tectonic
  // emits .synctex.gz when --synctex is passed) and only when the
  // file exists and parses cleanly. Typst doesn't currently produce
  // a synctex equivalent — the field is just absent there.
  synctex?: SynctexMap;
  // Non-fatal findings about a PDF the engine produced successfully —
  // today, fonts it referenced but did not embed (#80). Empty on a clean
  // compile. Recorded on the compile result and shown in the editor.
  warnings: string[];
}

export class CompileError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, stdout: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = 'CompileError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const FONT_EXT = /\.(otf|ttf|otc|ttc|woff2?)$/i;
const IMAGE_EXT = /\.(png|jpe?g|pdf|gif|svg|eps)$/i;

// Workdir-relative convention-mirror targets for one asset: a bare
// root-level font/image is also materialized under fonts/ / images/
// so `\includegraphics{images/foo.png}` works for users who haven't
// organised their project into folders. Never mirrors onto a path
// another asset explicitly occupies — the explicit file wins, and
// deterministically so (#82).
export function conventionMirrorRels(
  rel: string,
  filename: string,
  explicitPaths: ReadonlySet<string>,
): string[] {
  if (rel.includes('/')) return [];
  const out: string[] = [];
  if (FONT_EXT.test(filename)) out.push(`fonts/${filename}`);
  if (IMAGE_EXT.test(filename)) out.push(`images/${filename}`);
  return out.filter((m) => !explicitPaths.has(m));
}

// Construct the argv for a Tectonic compile run. Pulled out of
/**
 * The `aeolus-sandbox` argv that wraps the engine: allow read+write on the
 * workdir and the (optional) Tectonic cache, read-only on the engine binary
 * and the minimal system paths a static-musl engine plus fontconfig need,
 * everything else denied. Kept unit-testable like buildTectonicArgs.
 */
export function buildSandboxArgv(
  sandbox: SandboxConfig,
  opts: { engineBin: string; workdir: string; cacheDir?: string },
): string[] {
  const argv = [sandbox.bin, '--rw', opts.workdir];
  if (opts.cacheDir) argv.push('--rw', opts.cacheDir);
  argv.push('--ro', opts.engineBin);
  // The engine is a static-musl binary; these cover its loader-less runtime
  // plus fontconfig's system font/config lookup and TLS for bundle fetch.
  for (const ro of [
    '/usr',
    '/lib',
    '/lib64',
    '/etc/ssl',
    '/etc/fonts',
    '/etc/resolv.conf',
    '/dev/urandom',
    '/dev/null',
  ]) {
    argv.push('--ro', ro);
  }
  argv.push('--mode', sandbox.mode, '--');
  return argv;
}

// runCompile so the bundle / outdir / source plumbing is unit-
// testable without spinning up child_process.
export function buildTectonicArgs(opts: {
  workdir: string;
  sourceName: string;
  tectonicBundle?: string;
}): string[] {
  const args = ['-X', 'compile'];
  if (opts.tectonicBundle) {
    // Pin the bundle source so cold-start compiles don't depend
    // on the public relay (issue #11). The value is whatever the
    // operator put in AEOLUS_TECTONIC_BUNDLE: an S3 HTTPS URL, a
    // CTAN mirror URL, or a local path. tectonic auto-mirrors
    // the bundle into TECTONIC_CACHE_DIR on first use.
    args.push('--bundle', opts.tectonicBundle);
  }
  // --synctex emits <source>.synctex.gz alongside the pdf so the
  // editor can drive cursor↔PDF jumps. Cheap to enable
  // unconditionally; we strip the artifact on the worker after
  // parsing.
  args.push('--synctex');
  args.push('--outdir', opts.workdir, '--outfmt', 'pdf', opts.sourceName);
  return args;
}

export async function runCompile(options: CompileRunOptions): Promise<CompileRunResult> {
  const workdirBase = options.workdirBase ?? tmpdir();
  const workdir = await mkdtemp(path.join(workdirBase, 'ern-compile-'));
  try {
    const sourceName = options.engine === 'latex' ? 'main.tex' : 'main.typ';
    const outputName = 'main.pdf';
    const sourcePath = path.join(workdir, sourceName);
    const outputPath = path.join(workdir, outputName);
    await writeFile(sourcePath, options.source, 'utf8');

    if (options.assets) {
      // Materialize each asset at its project-relative `path`
      // (folder structure preserved via mkdir -p). Plus convention
      // mirroring to fonts/ and images/ for bare-filename assets so
      // users who haven't organised their project into folders yet
      // can still write \includegraphics{images/foo.png}. Same byte
      // stream, multiple paths via hardlink — no extra disk cost.
      const safe = (rel: string): string => {
        // Strip any leading separators and reject ../ traversal so
        // a malicious path can't escape the workdir.
        const norm = path.posix.normalize(rel.replace(/^\/+/, ''));
        if (norm.split('/').some((seg) => seg === '..')) {
          throw new Error(`unsafe asset path: ${rel}`);
        }
        return norm;
      };
      // Normalize every path up front so mirror planning can see the
      // whole project. A mirror must never land on a path some OTHER
      // asset explicitly claims — the writes below run concurrently,
      // so a root-level `X.ttf` mirroring to `fonts/X.ttf` while a
      // real `fonts/X.ttf` row exists made which bytes win a race
      // per compile (#82). The explicit asset always wins now.
      const normalized = options.assets.map((a) => ({ asset: a, rel: safe(a.path) }));
      const explicitPaths = new Set(normalized.map((n) => n.rel));
      const writes = normalized.map(async ({ asset: a, rel }) => {
        const filename = a.filename || path.posix.basename(rel);
        const root = path.join(workdir, rel);
        await mkdir(path.dirname(root), { recursive: true });
        await writeFile(root, a.data);

        // Convention mirroring only when the asset is at the workdir
        // root (no folder). A user who already put their image at
        // `figures/x.png` gets it materialized exactly there; we don't
        // additionally mirror it to images/.
        const mirrors = conventionMirrorRels(rel, filename, explicitPaths).map((m) =>
          path.join(workdir, m),
        );
        for (const mirror of mirrors) {
          await mkdir(path.dirname(mirror), { recursive: true });
          try {
            await link(root, mirror);
          } catch {
            await writeFile(mirror, a.data);
          }
        }
      });
      await Promise.all(writes);

      // Tectonic uses fontconfig (via font-kit) for font discovery,
      // and fontconfig only scans dirs listed in its config. Without
      // this, even with OSFONTDIR set, an uploaded .otf next to
      // main.tex is invisible to fontspec — the user gets:
      //   "Package fontspec Error: The font ... cannot be found."
      // Generate a fontconfig file that includes the system config
      // (so DejaVu etc. still work) plus the workdir, and point
      // FONTCONFIG_FILE at it. fontconfig builds the dir cache
      // lazily on first font query.
      const hasFonts = options.assets.some((a) => /\.(otf|ttf|otc|ttc|woff2?)$/i.test(a.filename));
      if (hasFonts) {
        const fcConfig = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${workdir}</dir>
  <cachedir>${workdir}/.fc-cache</cachedir>
</fontconfig>
`;
        await writeFile(path.join(workdir, 'fonts.conf'), fcConfig, 'utf8');
      }
    }

    const engineBin = options.engine === 'latex' ? options.tectonicBin : options.typstBin;
    const engineArgs =
      options.engine === 'latex'
        ? buildTectonicArgs({
            workdir,
            sourceName,
            tectonicBundle: options.tectonicBundle,
          })
        : ['compile', sourceName, outputName];

    // Confine the engine to the workdir + cache. Landlock rules inherit across
    // exec, so wrapping here sandboxes the engine and anything it spawns.
    const command = options.sandbox ? options.sandbox.bin : engineBin;
    const args = options.sandbox
      ? [
          ...buildSandboxArgv(options.sandbox, {
            engineBin,
            workdir,
            cacheDir: options.tectonicCacheDir,
          }).slice(1),
          engineBin,
          ...engineArgs,
        ]
      : engineArgs;

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: workdir,
      // OSFONTDIR covers XeTeX's traditional file-name lookup; the
      // fontconfig file (written above when assets include fonts)
      // covers Tectonic's font-kit / modern fontconfig path. Both
      // are needed because user references like
      // \setmainfont{Foo.otf} go through XeTeX's filename
      // resolution AND fontconfig depending on the engine version.
      OSFONTDIR: workdir,
      // Disable shell-escape and any other known-insecure engine features on
      // untrusted document source. --untrusted is not accepted by `-X compile`
      // (only `-X build` / the V1 CLI); the env var is the subcommand-agnostic
      // equivalent. Belt to aeolus-sandbox's filesystem confinement — Landlock
      // still permits exec of ro-allowed system binaries, which shell-escape
      // would use. (Ignored by Typst, which has no such feature.)
      TECTONIC_UNTRUSTED_MODE: '1',
    };
    const fcPath = path.join(workdir, 'fonts.conf');
    if (options.assets?.some((a) => /\.(otf|ttf|otc|ttc|woff2?)$/i.test(a.filename))) {
      env.FONTCONFIG_FILE = fcPath;
    }
    if (options.tectonicCacheDir) {
      env.TECTONIC_CACHE_DIR = options.tectonicCacheDir;
      env.XDG_CACHE_HOME = options.tectonicCacheDir;
    }

    const { stdout, stderr, exitCode } = await spawnLimited(command, args, {
      cwd: workdir,
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (exitCode !== 0) {
      throw new CompileError(
        `${options.engine} compile failed with exit code ${exitCode}`,
        stdout,
        stderr,
        exitCode,
      );
    }

    let pdf: Buffer;
    try {
      pdf = await readFile(outputPath);
    } catch {
      throw new CompileError(
        `${options.engine} compile produced no output PDF`,
        stdout,
        stderr,
        exitCode,
      );
    }
    if (pdf.length === 0) {
      throw new CompileError(
        `${options.engine} compile produced empty PDF`,
        stdout,
        stderr,
        exitCode,
      );
    }

    // Best-effort synctex pickup. Tectonic emits <source>.synctex.gz
    // when --synctex is set; a parse failure or missing file is
    // non-fatal — the compile already succeeded and the editor
    // gracefully degrades to "no jump targets".
    let synctex: SynctexMap | undefined;
    if (options.engine === 'latex') {
      const syncPath = path.join(workdir, sourceName.replace(/\.tex$/, '.synctex.gz'));
      try {
        const bytes = await readFile(syncPath);
        synctex = parseSynctex(bytes);
      } catch {
        synctex = undefined;
      }
    }

    // The engine said nothing, the previewer will substitute — so this is
    // the only place a non-embedded font gets noticed before the PDF
    // reaches a recipient. Best-effort: never fails a compile that passed.
    const warnings = fontEmbeddingWarnings(pdf);

    return { pdf, stdout, stderr, synctex, warnings };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface SpawnLimitedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface SpawnLimitedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function spawnLimited(
  command: string,
  args: string[],
  options: SpawnLimitedOptions,
): Promise<SpawnLimitedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      settled = true;
      reject(
        new CompileError(
          `compile timed out after ${options.timeoutMs}ms`,
          Buffer.concat(stdoutChunks).toString('utf8'),
          Buffer.concat(stderrChunks).toString('utf8'),
          null,
        ),
      );
    }, options.timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code,
      });
    });
  });
}
