#!/usr/bin/env node
// Holds the palette to WCAG AA. Runs in CI.
//
// The point of this file is that a colour change cannot quietly make text
// unreadable. Every pair below is a foreground the app actually paints on a
// background it actually paints it on, read from the real token definitions in
// src/styles/tokens.css and the real brand scale in tailwind.preset.cjs — not
// from a copy that can drift.
//
// What is NOT checked: Solarized's own accent hues in the editor. Solarized is
// an externally specified palette built around a narrow luminance range, and
// its stock accents sit between 2.9:1 and 4.8:1 against their own backgrounds
// by design. The brand steps the editor uses are checked, because those are
// ours to choose.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
  const h = hex.replace('#', '');
  const parts = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Parse tokens.css into one map per theme block.
 *
 * The file is four blocks in a fixed order: the light palette on bare :root,
 * the dark palette under a prefers-color-scheme media query, the same dark
 * palette under an explicit [data-theme="dark"], and the print reset. Each is
 * read separately, because a token that only resolves in one of them is
 * exactly the bug this notices.
 */
function readThemes() {
  const css = readFileSync(new URL('../apps/web/src/styles/tokens.css', import.meta.url), 'utf8');
  const blocks = [
    ['light', /^:root \{$/m],
    ['dark (system)', /^@media \(prefers-color-scheme: dark\) \{$/m],
    ['dark (explicit)', /^:root\[data-theme="dark"\] \{$/m],
    ['print', /^@media print \{$/m],
  ];
  const starts = blocks.map(([name, re]) => {
    const match = re.exec(css);
    if (!match) throw new Error(`tokens.css: could not find the ${name} block`);
    return { name, index: match.index };
  });
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : css.length;
    const body = css.slice(start.index, end);
    const values = new Map();
    for (const [, key, value] of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      // First definition wins: nothing in a block redefines a token.
      if (!values.has(key)) values.set(key, value.toLowerCase());
    }
    return { name: start.name, values };
  });
}

/**
 * Foreground/background pairs, by token name. `min` is the ratio the pair has
 * to clear: 4.5 for body text, 3.0 for large text and for anything that is a
 * boundary rather than a glyph.
 */
const PAIRS = [
  // Body copy on the two surfaces it lands on.
  ['ink', 'card', 4.5, 'body text on a card'],
  ['ink', 'bg', 4.5, 'body text on the page'],
  ['ink2', 'card', 4.5, 'secondary text on a card'],
  ['muted', 'card', 4.5, 'muted text on a card'],
  ['muted', 'bg', 4.5, 'muted text on the page'],
  ['placeholder', 'card', 4.5, 'input placeholder'],

  // The accent, which is the palette change most likely to break something.
  ['accent-text', 'card', 4.5, 'accent text on a card'],
  ['accent-text', 'bg', 4.5, 'accent text on the page'],
  ['accent-fg', 'accent-bg', 4.5, 'accent badge text'],
  ['accent-fg-strong', 'accent-bg', 4.5, 'emphasised accent badge text'],
  ['accent-edge', 'card', 3, 'accent border on a card'],
  ['focus', 'card', 3, 'focus ring on a card'],

  // Buttons.
  ['btn-primary-fg', 'btn-primary-bg', 4.5, 'primary button label'],
  ['btn-danger-fg', 'btn-danger-bg', 4.5, 'danger button label'],
  ['inverse-fg', 'inverse-bg', 4.5, 'inverse surface text'],

  // Status colours, which carry meaning and so must be readable.
  ['success-fg', 'success-bg', 4.5, 'success badge'],
  ['danger-fg', 'danger-bg', 4.5, 'danger badge'],
  ['warning-fg', 'warning-bg', 4.5, 'warning badge'],
  ['notice-fg', 'notice-bg', 4.5, 'notice badge'],
  ['info-fg', 'info-bg', 4.5, 'info badge'],
  ['neutral-fg', 'neutral-bg', 4.5, 'neutral badge'],
];

/**
 * The editor. Solarized's backgrounds are fixed by the upstream spec; the
 * brand steps painted on them are ours, and these are the ones
 * apps/web/src/lib/editor-theme.ts actually uses.
 */
const SOLARIZED_DARK_BG = '#002b36';
const SOLARIZED_LIGHT_BG = '#fdf6e3';
const EDITOR_PAIRS = [
  ['200', SOLARIZED_DARK_BG, 4.5, 'heading, dark editor'],
  ['300', SOLARIZED_DARK_BG, 4.5, 'keyword, dark editor'],
  ['400', SOLARIZED_DARK_BG, 4.5, 'type name and caret, dark editor'],
  ['500', SOLARIZED_DARK_BG, 4.5, 'operator, dark editor'],
  ['700', SOLARIZED_LIGHT_BG, 4.5, 'operator and caret, light editor'],
  ['800', SOLARIZED_LIGHT_BG, 4.5, 'keyword, light editor'],
  ['900', SOLARIZED_LIGHT_BG, 4.5, 'type name and heading, light editor'],
];

const failures = [];
const checked = [];

for (const theme of readThemes()) {
  for (const [fg, bg, min, what] of PAIRS) {
    const fgValue = theme.values.get(fg);
    const bgValue = theme.values.get(bg);
    if (!fgValue || !bgValue) {
      // A token missing from a block is its own bug: it resolves to nothing.
      failures.push(`${theme.name}: --${!fgValue ? fg : bg} is not defined in this block`);
      continue;
    }
    const ratio = contrast(fgValue, bgValue);
    checked.push(`${theme.name} · ${what}: ${ratio.toFixed(2)}:1`);
    if (ratio < min) {
      failures.push(
        `${theme.name}: ${what} — --${fg} ${fgValue} on --${bg} ${bgValue} is ` +
          `${ratio.toFixed(2)}:1, needs ${min}:1`,
      );
    }
  }
}

const brand = require(`${ROOT}apps/web/tailwind.preset.cjs`).theme.extend.colors.brand;
for (const [step, bg, min, what] of EDITOR_PAIRS) {
  const value = brand[step];
  if (!value) {
    failures.push(`brand-${step} is not in the preset, but editor-theme.ts uses it`);
    continue;
  }
  const ratio = contrast(value, bg);
  checked.push(`editor · ${what}: ${ratio.toFixed(2)}:1`);
  if (ratio < min) {
    failures.push(
      `editor: ${what} — brand-${step} ${value} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`,
    );
  }
}

if (process.argv.includes('--verbose')) {
  for (const line of checked) console.log(`  ${line}`);
}

if (failures.length > 0) {
  console.error(`check-contrast: ${failures.length} pair(s) below the floor\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nFix the token, not the threshold.');
  process.exit(1);
}

console.log(`check-contrast: ${checked.length} pairs, all above the floor`);
