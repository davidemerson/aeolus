import { describe, expect, it } from 'vitest';

import { findForwardTarget, findReverseTarget, type SynctexMap } from './synctex.js';

const SAMPLE: SynctexMap = {
  version: 1,
  files: ['main.tex', 'chapters/intro.tex'],
  forward: {
    'main.tex': [
      { file: 'main.tex', line: 5, page: 1, x: 472, y: 472, w: 0, h: 0 },
      { file: 'main.tex', line: 7, page: 1, x: 472, y: 2_000_000, w: 0, h: 0 },
      { file: 'main.tex', line: 42, page: 2, x: 472, y: 472, w: 0, h: 0 },
    ],
    'chapters/intro.tex': [
      { file: 'chapters/intro.tex', line: 3, page: 1, x: 472, y: 3_000_000, w: 0, h: 0 },
    ],
  },
  reverse: {
    1: [
      { file: 'main.tex', line: 5, page: 1, x: 472, y: 472, w: 0, h: 0 },
      { file: 'main.tex', line: 7, page: 1, x: 472, y: 2_000_000, w: 0, h: 0 },
      { file: 'chapters/intro.tex', line: 3, page: 1, x: 472, y: 3_000_000, w: 0, h: 0 },
    ],
    2: [{ file: 'main.tex', line: 42, page: 2, x: 472, y: 472, w: 0, h: 0 }],
  },
};

describe('findForwardTarget', () => {
  it('returns the first record at-or-after the target line', () => {
    expect(findForwardTarget(SAMPLE, 'main.tex', 5)?.line).toBe(5);
    expect(findForwardTarget(SAMPLE, 'main.tex', 6)?.line).toBe(7);
    expect(findForwardTarget(SAMPLE, 'main.tex', 42)?.page).toBe(2);
  });

  it('falls back to the last record when line is past the end', () => {
    expect(findForwardTarget(SAMPLE, 'main.tex', 999)?.line).toBe(42);
  });

  it('matches by suffix when the file key uses a different prefix', () => {
    // Caller passes 'intro.tex'; the map key is 'chapters/intro.tex'.
    expect(findForwardTarget(SAMPLE, 'intro.tex', 1)?.file).toBe('chapters/intro.tex');
  });

  it('returns null when no record matches the file', () => {
    expect(findForwardTarget(SAMPLE, 'unknown.tex', 1)).toBeNull();
  });
});

describe('findReverseTarget', () => {
  it('returns the closest box on the requested page', () => {
    // PDF click near the top of page 1 (y ≈ 0 pt) should pick the
    // line-5 box (y = 472 sp ≈ 0.007 pt).
    const target = findReverseTarget(SAMPLE, 1, 10, 0);
    expect(target?.line).toBe(5);
  });

  it('returns null when the page is empty', () => {
    expect(findReverseTarget(SAMPLE, 99, 0, 0)).toBeNull();
  });

  it('picks a deeper box when y is large', () => {
    // 46 pt = 46 * 65536 = 3,014,656 sp; closest record is line-3
    // (y = 3,000,000 sp).
    const target = findReverseTarget(SAMPLE, 1, 10, 46);
    expect(target?.line).toBe(3);
  });
});
