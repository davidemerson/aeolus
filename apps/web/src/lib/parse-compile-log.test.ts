import { describe, expect, it } from 'vitest';

import { firstActionable, parseCompileLog } from './parse-compile-log.js';

// Fixtures lifted from real Tectonic 0.15 + Typst 0.12 output. The
// parser is intentionally permissive — these aren't golden parses,
// they pin the shape the UI relies on.

describe('parseCompileLog', () => {
  it('extracts an Undefined control sequence error with line + context', () => {
    const log = [
      'Running TeX ...',
      '! Undefined control sequence.',
      'l.5 \\hello',
      '         ',
      'The control sequence at the end of the top line of your error',
      "message was never \\def'ed.",
    ].join('\n');
    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: 'error',
      line: 5,
      message: 'Undefined control sequence.',
      context: '\\hello',
    });
  });

  it("extracts the line from Tectonic's own driver format, which has no column", () => {
    // What compile_results.error actually holds for a Tectonic failure:
    // the driver's `error: <file>:<line>: <message>` line, not the TeX
    // log's `! … / l.N` pair. #57's window depends on this parsing.
    const log = [
      'error: main.tex:22: Undefined control sequence.',
      'error: halted on potentially-recoverable error as specified',
    ].join('\n');
    const entries = parseCompileLog(log);
    expect(entries[0]).toMatchObject({
      severity: 'error',
      line: 22,
      message: 'Undefined control sequence.',
    });
    expect(firstActionable(entries)?.line).toBe(22);
  });

  it('extracts a structured LaTeX Error with file/package detail', () => {
    const log = [
      "! LaTeX Error: File `xyz.sty' not found.",
      'Type X to quit or <return> to proceed,',
      'or enter new name. (Default extension: sty)',
    ].join('\n');
    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: 'error',
      line: null,
      message: "File `xyz.sty' not found.",
    });
  });

  it('classifies overfull boxes as warnings with a line number when present', () => {
    const log = [
      'Overfull \\hbox (1.234pt too wide) in paragraph at lines 7--9',
      'Some other line',
      'Underfull \\vbox detected while \\output is active [12]',
    ].join('\n');
    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ severity: 'warning', line: 7 });
    expect(entries[1]).toMatchObject({ severity: 'warning' });
  });

  it('extracts LaTeX Warning lines with embedded line numbers', () => {
    const log = "LaTeX Warning: Reference `foo' on input line 42 undefined.";
    const entries = parseCompileLog(log);
    expect(entries[0]).toMatchObject({
      severity: 'warning',
      line: 42,
    });
  });

  it('extracts Typst-style error: with main.typ:L:C pointer', () => {
    const log = [
      'error: file not found (searched at typst-packages/...)',
      '   ┌─ main.typ:5:10',
      '   │',
      ' 5 │ #image("foo.png")',
    ].join('\n');
    const entries = parseCompileLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: 'error',
      line: 5,
      message: 'file not found (searched at typst-packages/...)',
    });
  });

  it('returns [] for empty / null / whitespace input', () => {
    expect(parseCompileLog('')).toEqual([]);
    expect(parseCompileLog(null)).toEqual([]);
    expect(parseCompileLog(undefined)).toEqual([]);
    expect(parseCompileLog('   \n\n   ')).toEqual([]);
  });
});

describe('firstActionable', () => {
  it('prefers errors over warnings', () => {
    const entries = [
      { severity: 'warning' as const, line: 1, message: 'w' },
      { severity: 'error' as const, line: 2, message: 'e' },
    ];
    expect(firstActionable(entries)?.message).toBe('e');
  });

  it('falls back to the first warning', () => {
    const entries = [
      { severity: 'warning' as const, line: 1, message: 'w1' },
      { severity: 'warning' as const, line: 2, message: 'w2' },
    ];
    expect(firstActionable(entries)?.message).toBe('w1');
  });

  it('returns null on empty', () => {
    expect(firstActionable([])).toBeNull();
  });
});
