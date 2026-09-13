import { CompileError } from './runner.js';

// Turns whatever the compile pipeline threw into the single string the
// author sees. It lands in three places at once — the editor's status
// bar, the logs pane, and the "Compile failed" card — so it has to read
// as a sentence, not as a Node internal.
//
// Lifted out of worker.ts so the mapping is unit-testable without
// standing up pg-boss and a database, following buildTectonicArgs in
// runner.ts.

// A failure to *launch* the engine is not a document error, and Node's
// message for it ("spawn tectonic ENOENT") tells the author nothing they
// can act on — it reads like their LaTeX is broken when in fact the
// image is missing a binary, TECTONIC_BIN points somewhere wrong, or the
// mount is not executable. Those get a message that names the cause and
// says whose problem it is. The raw errno stays on the second line: it
// is what an operator greps for.
export function formatSpawnFailure(err: NodeJS.ErrnoException): string | null {
  // syscall is "spawn <binary>" for a launch failure. A compile that
  // actually ran and exited non-zero arrives as CompileError instead, so
  // a real LaTeX error never reaches this branch.
  if (typeof err.syscall !== 'string' || !err.syscall.startsWith('spawn')) return null;
  const binary = err.path ?? (err.syscall.slice('spawn '.length) || 'the compile engine');
  const why =
    err.code === 'ENOENT'
      ? `The ${binary} compile engine is not installed on the compile worker.`
      : err.code === 'EACCES' || err.code === 'EPERM'
        ? `The compile worker is not allowed to execute ${binary}.`
        : `The compile worker could not start ${binary}.`;
  return `${why} This is a problem with Aeolus's deployment, not with your document — tell an administrator.\n${
    err.syscall
  }${err.code === undefined ? '' : ` ${err.code}`}`;
}

// Everything that is neither an engine result nor a launch failure — an
// S3 GET, a doc_updates read, a bug — used to reach the author as
// err.message, which can carry a bucket name or an object key. The author
// gets one sentence; the message itself goes to the worker log (see
// processJob's catch).
export const INTERNAL_COMPILE_FAILURE =
  'Aeolus could not complete this compile because of a problem on its side, not in your ' +
  'document. Try again in a minute; if it keeps failing, tell an administrator.';

export interface FormattedCompileError {
  message: string;
  // true when the text is about the author's document (engine output) or
  // an operator-facing deployment fault that is already worded for them;
  // false when the original error was withheld and must be logged.
  authorFault: boolean;
}

export function formatCompileError(err: unknown): FormattedCompileError {
  if (err instanceof CompileError) {
    const detail = err.stderr.trim() || err.stdout.trim();
    return {
      message: detail.length > 0 ? `${err.message}\n${detail}` : err.message,
      authorFault: true,
    };
  }
  if (err instanceof Error) {
    const spawn = formatSpawnFailure(err as NodeJS.ErrnoException);
    if (spawn) return { message: spawn, authorFault: true };
  }
  return { message: INTERNAL_COMPILE_FAILURE, authorFault: false };
}
