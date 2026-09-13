// Best-effort structured parse of a Tectonic / Typst compile log.
// We extract the first useful error and the offending source line so
// the UI can render a prominent "click to jump" card. Anything not
// recognised falls into the raw log path; the parser never throws.
//
// Tectonic's error shape (XeTeX-flavoured) looks like:
//   ! Undefined control sequence.
//   l.5 \hello
//            (truncated context)
//
// or:
//   ! LaTeX Error: File `xyz.sty' not found.
//
// Warnings:
//   Overfull \hbox (1.234pt too wide) in paragraph at lines 7--9
//   LaTeX Warning: Citation `foo' on page 1 undefined ...
//
// Tectonic's own driver line (0.9+), which is what the worker stores when
// the TeX log excerpt is not part of stderr — line only, no column:
//   error: main.tex:22: Undefined control sequence.
//
// Typst's shape:
//   error: file not found
//      ┌─ main.typ:5:10
//
// We match a permissive set of patterns so any of these forms surface
// as a `{ severity, message, line, context? }` record.

export interface ParsedCompileEntry {
  severity: 'error' | 'warning';
  // Source line referenced by the entry, when extractable.
  line: number | null;
  message: string;
  // The offending source snippet captured next to the message —
  // typically the `l.N <content>` line in Tectonic logs.
  context?: string;
}

const TECTONIC_BANG_RE = /^!\s+(.*)$/;
const TECTONIC_LINE_RE = /^l\.(\d+)\s*(.*)$/;
const LATEX_ERROR_RE = /^!\s*LaTeX Error:\s*(.+)$/;
const LATEX_WARNING_RE = /^LaTeX Warning:\s*(.+)$/;
const OVERFULL_RE = /^(Over|Under)full\s+\\(?:hbox|vbox)\b.*?(?:lines?\s+(\d+)(?:--\d+)?)?\s*$/i;
const TYPST_ERROR_RE = /^error:\s*(.+)$/;
const TYPST_LOC_RE = /\b(?:[A-Za-z0-9_./-]+):(\d+):\d+\b/;
// `error: <file>:<line>: <message>` — Tectonic's driver format. The file
// segment must look like a path with an extension so a message that merely
// contains a colon-separated number is not mistaken for a location.
const TECTONIC_DRIVER_RE = /^error:\s*([A-Za-z0-9_./-]+\.[A-Za-z]+):(\d+):\s*(.+)$/;

export function parseCompileLog(raw: string | null | undefined): ParsedCompileEntry[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  const out: ParsedCompileEntry[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // LaTeX Error: prefix takes priority — it's already structured.
    const latexErr = LATEX_ERROR_RE.exec(line);
    if (latexErr) {
      const { message, sourceLine, context } = lookaheadForSourceLine(lines, i + 1);
      out.push({
        severity: 'error',
        line: sourceLine,
        message: latexErr[1],
        context,
      });
      // skip past consumed context lines
      if (message != null) i = message;
      continue;
    }

    // Plain `! foo` (Undefined control sequence, etc.)
    const bang = TECTONIC_BANG_RE.exec(line);
    if (bang) {
      const { message, sourceLine, context } = lookaheadForSourceLine(lines, i + 1);
      out.push({
        severity: 'error',
        line: sourceLine,
        message: bang[1],
        context,
      });
      if (message != null) i = message;
      continue;
    }

    // LaTeX Warning: ...
    const latexWarn = LATEX_WARNING_RE.exec(line);
    if (latexWarn) {
      // Optional "on input line N" or "on page" suffix.
      const lineMatch = /\bline\s+(\d+)/i.exec(latexWarn[1]);
      out.push({
        severity: 'warning',
        line: lineMatch ? parseInt(lineMatch[1], 10) : null,
        message: latexWarn[1],
      });
      continue;
    }

    // Overfull / Underfull boxes — frequent and noisy; surface them
    // as warnings with a line range when present.
    const over = OVERFULL_RE.exec(line);
    if (over) {
      out.push({
        severity: 'warning',
        line: over[2] ? parseInt(over[2], 10) : null,
        message: line.trim(),
      });
      continue;
    }

    // Tectonic driver line: `error: main.tex:22: Undefined control sequence.`
    const driver = TECTONIC_DRIVER_RE.exec(line);
    if (driver) {
      out.push({
        severity: 'error',
        line: parseInt(driver[2], 10),
        message: driver[3].trim(),
      });
      continue;
    }

    // Typst-style "error: ..." with a possible "main.typ:L:C" pointer
    // on the next non-empty line.
    const typstErr = TYPST_ERROR_RE.exec(line);
    if (typstErr) {
      let typstLine: number | null = null;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
        const m = TYPST_LOC_RE.exec(lines[j]);
        if (m) {
          typstLine = parseInt(m[1], 10);
          break;
        }
      }
      out.push({
        severity: 'error',
        line: typstLine,
        message: typstErr[1],
      });
      continue;
    }
  }

  return out;
}

// Scan forward from `start` for the `l.N <context>` line that
// Tectonic prints two lines after a `! ...` header. Returns the
// resolved source line and the context, plus an updated index the
// outer loop can jump to so the same lines aren't re-parsed.
function lookaheadForSourceLine(
  lines: readonly string[],
  start: number,
): { sourceLine: number | null; context?: string; message: number | null } {
  for (let j = start; j < Math.min(start + 6, lines.length); j += 1) {
    const m = TECTONIC_LINE_RE.exec(lines[j]);
    if (m) {
      const lineNumber = parseInt(m[1], 10);
      const context = m[2].trim() || lines[j + 1]?.trim();
      return { sourceLine: lineNumber, context, message: j };
    }
  }
  return { sourceLine: null, message: null };
}

// First error if any, else first warning. Used by the UI to render a
// prominent "fix this first" card without forcing the user to scan
// the full log.
export function firstActionable(entries: readonly ParsedCompileEntry[]): ParsedCompileEntry | null {
  return (
    entries.find((e) => e.severity === 'error') ??
    entries.find((e) => e.severity === 'warning') ??
    null
  );
}
