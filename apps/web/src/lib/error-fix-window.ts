// The excerpt "Ask Claude to fix" sends — and replaces — for a compile
// error, instead of the whole document (#57).
//
// A compile error names one source line (parse-compile-log.ts extracts
// it from Tectonic's `l.N` / Typst's `main.typ:N:C`). Sending the entire
// document for a one-line mistake spent tokens and time rewriting text
// that was fine, and the wholesale replace on Accept could touch every
// line. So the request is scoped to a window around that line: up to
// `contextLines` lines on each side, then widened outward to the nearest
// blank line so the excerpt is whole paragraphs / environments rather
// than a cut mid-sentence — but never beyond `2 * contextLines` from the
// error, so a document with no blank lines still gets a bounded window.
//
// Pure over the source string so it is unit-testable; the editor maps
// the 1-based line range onto CodeMirror positions.

export interface FixWindow {
  // 1-based, inclusive.
  fromLine: number;
  toLine: number;
  totalLines: number;
}

export const DEFAULT_CONTEXT_LINES = 20;

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

export function fixWindowFor(
  source: string,
  errorLine: number | null | undefined,
  opts: { contextLines?: number } = {},
): FixWindow | null {
  if (errorLine == null || !Number.isInteger(errorLine) || errorLine < 1) return null;
  const lines = source.split('\n');
  const totalLines = lines.length;
  if (errorLine > totalLines) return null;

  const context = opts.contextLines ?? DEFAULT_CONTEXT_LINES;
  const hardFloor = Math.max(1, errorLine - 2 * context);
  const hardCeil = Math.min(totalLines, errorLine + 2 * context);

  let fromLine = Math.max(1, errorLine - context);
  let toLine = Math.min(totalLines, errorLine + context);

  // If the window landed on blank lines at either edge, pull them in —
  // those edges are already paragraph boundaries.
  while (fromLine < errorLine && isBlank(lines[fromLine - 1])) fromLine += 1;
  while (toLine > errorLine && isBlank(lines[toLine - 1])) toLine -= 1;

  // Then widen outward until the line just outside the excerpt is blank
  // (the blank line itself stays outside), bounded by the hard limits.
  while (fromLine > hardFloor && !isBlank(lines[fromLine - 2])) fromLine -= 1;
  while (toLine < hardCeil && !isBlank(lines[toLine])) toLine += 1;

  return { fromLine, toLine, totalLines };
}

// Human label for the AI panel, so the reader sees the scope before
// they click Accept.
export function describeFixWindow(w: FixWindow | null): string {
  if (!w) return 'Fixing the whole document — the log names no source line';
  if (w.fromLine === w.toLine) return `Fixing line ${w.fromLine} of ${w.totalLines}`;
  return `Fixing lines ${w.fromLine}–${w.toLine} of ${w.totalLines}`;
}
