import { describe, expect, it } from 'vitest';

import { describeFixWindow, fixWindowFor } from './error-fix-window.js';

// Build a document of `n` numbered lines with blank lines at the given
// (1-based) positions, so the paragraph snapping is easy to reason about.
function doc(n: number, blanks: number[] = []): string {
  return Array.from({ length: n }, (_, i) => (blanks.includes(i + 1) ? '' : `Line ${i + 1}.`)).join(
    '\n',
  );
}

describe('fixWindowFor', () => {
  it('returns null when the log named no line', () => {
    expect(fixWindowFor(doc(50), null)).toBeNull();
    expect(fixWindowFor(doc(50), undefined)).toBeNull();
  });

  it('returns null for a line outside the document', () => {
    expect(fixWindowFor(doc(50), 0)).toBeNull();
    expect(fixWindowFor(doc(50), 51)).toBeNull();
    expect(fixWindowFor(doc(50), 2.5)).toBeNull();
  });

  it('centres a bounded window on the error line in a document with no blank lines', () => {
    const w = fixWindowFor(doc(200), 100, { contextLines: 10 });
    // No blank line to snap to: widens to the hard limit of 2x context.
    expect(w).toEqual({ fromLine: 80, toLine: 120, totalLines: 200 });
  });

  it('snaps outward to the nearest blank lines, keeping the blanks outside', () => {
    // Paragraph boundaries at 12 and 31; error at 22. Context 6 puts the
    // initial window at 16–28 and the 2x hard limit at 10–34, so the
    // blank lines are reachable and win.
    const w = fixWindowFor(doc(60, [12, 31]), 22, { contextLines: 6 });
    expect(w).toEqual({ fromLine: 13, toLine: 30, totalLines: 60 });
  });

  it('clamps to the start and end of the document', () => {
    expect(fixWindowFor(doc(10), 1, { contextLines: 5 })).toEqual({
      fromLine: 1,
      toLine: 10,
      totalLines: 10,
    });
    expect(fixWindowFor(doc(10), 10, { contextLines: 5 })).toEqual({
      fromLine: 1,
      toLine: 10,
      totalLines: 10,
    });
  });

  it('never covers the whole document when the error sits in a paragraph of a long one', () => {
    const blanks = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const w = fixWindowFor(doc(100, blanks), 45);
    expect(w).not.toBeNull();
    expect(w!.fromLine).toBeLessThanOrEqual(45);
    expect(w!.toLine).toBeGreaterThanOrEqual(45);
    expect(w!.toLine - w!.fromLine + 1).toBeLessThan(100);
  });

  it('pulls blank edge lines inward', () => {
    // Error at 5; lines 3 and 7 are blank; context 2 lands exactly on them.
    const w = fixWindowFor(doc(10, [3, 7]), 5, { contextLines: 2 });
    expect(w).toEqual({ fromLine: 4, toLine: 6, totalLines: 10 });
  });
});

describe('describeFixWindow', () => {
  it('names the range, a single line, or the whole-document fallback', () => {
    expect(describeFixWindow({ fromLine: 13, toLine: 30, totalLines: 60 })).toBe(
      'Fixing lines 13–30 of 60',
    );
    expect(describeFixWindow({ fromLine: 7, toLine: 7, totalLines: 9 })).toBe('Fixing line 7 of 9');
    expect(describeFixWindow(null)).toMatch(/whole document/);
  });
});
