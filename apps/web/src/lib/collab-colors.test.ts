import { describe, expect, it } from 'vitest';

import {
  collabColorFor,
  collabNameFor,
  collabUserFor,
  DARK_GROUND,
  DARK_PALETTE,
  LIGHT_GROUND,
  LIGHT_PALETTE,
  paletteIndex,
} from './collab-colors.js';

// The palette's distinguishability claims are checked here, not only
// written in the file header. CIE76 ΔE in CIELAB (D65) and WCAG 2.x
// relative-luminance contrast — enough to catch a hue edit that puts
// two collaborators within confusion range of each other or of the
// ground.
const hex2rgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb2xyz = ([r, g, b]: [number, number, number]): [number, number, number] => {
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  return [
    lr * 0.4124 + lg * 0.3576 + lb * 0.1805,
    lr * 0.2126 + lg * 0.7152 + lb * 0.0722,
    lr * 0.0193 + lg * 0.1192 + lb * 0.9505,
  ];
};
const xyz2lab = ([x, y, z]: [number, number, number]): [number, number, number] => {
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [xr, yr, zr] = [x / 0.95047, y / 1, z / 1.08883];
  return [116 * f(yr) - 16, 500 * (f(xr) - f(yr)), 200 * (f(yr) - f(zr))];
};
const lab = (h: string): [number, number, number] => xyz2lab(rgb2xyz(hex2rgb(h)));
const deltaE = (a: string, b: string): number => {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};
const luminance = (h: string): number => rgb2xyz(hex2rgb(h))[1];
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

function minPairwiseDeltaE(palette: readonly string[]): number {
  let min = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    for (let j = i + 1; j < palette.length; j += 1) {
      min = Math.min(min, deltaE(palette[i]!, palette[j]!));
    }
  }
  return min;
}

describe('collaborator palettes', () => {
  it('has eight distinct hues per ground', () => {
    expect(LIGHT_PALETTE).toHaveLength(8);
    expect(DARK_PALETTE).toHaveLength(8);
    expect(new Set(LIGHT_PALETTE).size).toBe(8);
    expect(new Set(DARK_PALETTE).size).toBe(8);
  });

  it('keeps every pair of hues at least ΔE76 20 apart, on both grounds', () => {
    expect(minPairwiseDeltaE(LIGHT_PALETTE)).toBeGreaterThanOrEqual(20);
    expect(minPairwiseDeltaE(DARK_PALETTE)).toBeGreaterThanOrEqual(20);
  });

  it('keeps every caret at least 3:1 against its ground', () => {
    for (const c of LIGHT_PALETTE) expect(contrast(c, LIGHT_GROUND)).toBeGreaterThanOrEqual(3);
    for (const c of DARK_PALETTE) expect(contrast(c, DARK_GROUND)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the caret label readable: white on light carets, base03 on dark carets', () => {
    for (const c of LIGHT_PALETTE) expect(contrast(c, '#ffffff')).toBeGreaterThanOrEqual(4);
    for (const c of DARK_PALETTE) expect(contrast(c, DARK_GROUND)).toBeGreaterThanOrEqual(4);
  });
});

describe('collabColorFor', () => {
  it('is deterministic per user id and spreads ids across the palette', () => {
    const id = '0d0e7d1e-2c5c-4d3b-9b1e-7d9a5b1a2c3d';
    expect(collabColorFor(id, false)).toEqual(collabColorFor(id, false));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) seen.add(paletteIndex(`user-${i}-${i * 7919}`));
    expect(seen.size).toBe(8);
  });

  it('picks the same palette slot on both grounds, so a person keeps their hue across themes', () => {
    const id = 'f8c5a0d2-1b2c-4e3f-8a9b-0c1d2e3f4a5b';
    const light = collabColorFor(id, false);
    const dark = collabColorFor(id, true);
    expect(LIGHT_PALETTE.indexOf(light.color)).toBe(DARK_PALETTE.indexOf(dark.color));
  });

  it('tints selections more strongly on the dark ground', () => {
    const id = 'abc';
    expect(collabColorFor(id, false).colorLight.endsWith('40')).toBe(true);
    expect(collabColorFor(id, true).colorLight.endsWith('59')).toBe(true);
  });
});

describe('collabNameFor / collabUserFor', () => {
  it('prefers the display name, falls back to the mailbox, never Anonymous', () => {
    expect(collabNameFor({ name: 'Ada Lovelace', email: 'ada@example.com' })).toBe('Ada Lovelace');
    expect(collabNameFor({ name: '  ', email: 'ada@example.com' })).toBe('ada');
    expect(collabNameFor({ name: null, email: 'ada@example.com' })).toBe('ada');
    const u = collabUserFor({ id: 'x', name: null, email: 'ada@example.com' }, true);
    expect(u.name).toBe('ada');
    expect(DARK_PALETTE).toContain(u.color);
  });
});
