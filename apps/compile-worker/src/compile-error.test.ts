import { describe, expect, it } from 'vitest';

import {
  INTERNAL_COMPILE_FAILURE,
  formatCompileError,
  formatSpawnFailure,
} from './compile-error.js';
import { CompileError } from './runner.js';

// Builds the error object Node actually produces when spawn() cannot
// launch a binary, so the test asserts against the real shape rather
// than an invented one.
function spawnError(code: string, binary: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`spawn ${binary} ${code}`);
  err.code = code;
  err.syscall = `spawn ${binary}`;
  err.path = binary;
  return err;
}

describe('formatSpawnFailure', () => {
  it('explains a missing engine binary instead of echoing the errno', () => {
    const msg = formatSpawnFailure(spawnError('ENOENT', 'tectonic'));
    expect(msg).not.toBeNull();
    // The author must not be told "spawn tectonic ENOENT" and nothing else:
    // it reads as though their document is at fault.
    expect(msg).toContain('tectonic compile engine is not installed');
    expect(msg).toContain('not with your document');
    // ...but the raw errno stays, on its own line, for whoever is on call.
    expect(msg).toContain('spawn tectonic ENOENT');
  });

  it('distinguishes a permission failure from a missing binary', () => {
    const msg = formatSpawnFailure(spawnError('EACCES', '/usr/local/bin/typst'));
    expect(msg).toContain('not allowed to execute /usr/local/bin/typst');
    expect(msg).toContain('spawn /usr/local/bin/typst EACCES');
  });

  it('still produces a sentence for an unfamiliar spawn errno', () => {
    const msg = formatSpawnFailure(spawnError('EAGAIN', 'tectonic'));
    expect(msg).toContain('could not start tectonic');
  });

  // The guard that keeps real LaTeX errors out of the deployment-problem
  // wording. Without it, any Error whose message happened to be
  // reformatted here would be blamed on the deployment.
  it('returns null for an error that is not a spawn failure', () => {
    const notSpawn: NodeJS.ErrnoException = new Error('ENOSPC: no space left');
    notSpawn.code = 'ENOSPC';
    notSpawn.syscall = 'write';
    expect(formatSpawnFailure(notSpawn)).toBeNull();
    expect(formatSpawnFailure(new Error('plain'))).toBeNull();
  });
});

describe('formatCompileError', () => {
  it('prefers stderr for a compile that ran and failed', () => {
    const err = new CompileError('compile failed', 'out', '! Undefined control sequence.', 1);
    expect(formatCompileError(err)).toEqual({
      message: 'compile failed\n! Undefined control sequence.',
      authorFault: true,
    });
  });

  it('falls back to stdout when stderr is empty', () => {
    const err = new CompileError('compile failed', '! Missing $ inserted.', '   ', 1);
    expect(formatCompileError(err).message).toBe('compile failed\n! Missing $ inserted.');
  });

  it('returns the bare message when the engine printed nothing', () => {
    expect(
      formatCompileError(new CompileError('compile timed out after 45000ms', '', '', null)).message,
    ).toBe('compile timed out after 45000ms');
  });

  it('routes a spawn failure through the human explanation', () => {
    const formatted = formatCompileError(spawnError('ENOENT', 'tectonic'));
    expect(formatted.message).toContain('is not installed on the compile worker');
    expect(formatted.authorFault).toBe(true);
  });

  it('withholds an ordinary Error and flags it for the log', () => {
    // An S3 GET or a DB read failing is not the author's problem and its
    // message can carry a bucket name or an object key.
    const formatted = formatCompileError(new Error('NoSuchBucket: aeolus-blobs-nonprod'));
    expect(formatted.authorFault).toBe(false);
    expect(formatted.message).toBe(INTERNAL_COMPILE_FAILURE);
    expect(formatted.message).not.toContain('aeolus-blobs');
  });
  it('withholds a non-Error throw too', () => {
    const formatted = formatCompileError('boom');
    expect(formatted).toEqual({ message: INTERNAL_COMPILE_FAILURE, authorFault: false });
  });
});
