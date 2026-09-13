#!/usr/bin/env node
/**
 * Fail on Tailwind colour utilities that emit no CSS.
 *
 * The rule: every utility you write has to actually exist. A missing Tailwind
 * colour key emits no CSS and no error. That check was originally done by
 * flattening the preset's colour map to a key set and diffing it against the
 * class names in the source, which is how dozens of dead `hover:border-accent`
 * and `text-ink-400` uses surfaced.
 *
 * A preset-key diff is not enough. It says nothing about the OPACITY MODIFIER, and in Tailwind 3.4 a modifier on a
 * plain `var()`-backed colour is silently dropped:
 *
 *     border-[#b91c1c]/40        emits   (an arbitrary hex carries its own alpha)
 *     border-hairline-strong/80  EMITS NOTHING
 *
 * Both look equally correct in a diff, both look plausible in review, and the
 * second one leaves the element with Tailwind's DEFAULT border colour rather
 * than no border — so it renders as a real hairline of the wrong colour, in
 * both themes, which is why nobody caught it by looking. Five of these were
 * live in this app before the conversion, including the one on the header's
 * bottom edge.
 *
 * So this checks the thing that actually matters: does the class name in the
 * source appear as a selector in the built stylesheet. It catches the missing
 * key, the modifier, a typo, and anything else that ends the same way.
 *
 *   node scripts/check-dead-utilities.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// The stylesheet with the @tailwind directives — the input Tailwind compiles.
const ENTRY_CSS = 'src/styles/globals.css';

// Prefixes whose failure mode is invisible: the element still renders, just
// with the wrong colour or none. Layout utilities are excluded because a dead
// `w-` or `flex-` is obvious the moment anyone opens the page.
const COLOUR_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'ring-offset',
  'fill',
  'stroke',
  'from',
  'to',
  'via',
  'divide',
  'outline',
  'accent',
  'caret',
  'decoration',
  'placeholder',
  'shadow',
];

// `text-` and `shadow-` are not only colour scales — text-sm and shadow-lg are
// size utilities off a different scale, and an arbitrary value like
// text-[11px] is a size too. Those are all still asserted (a dead text-[11px]
// is just as silent), so no exclusion is needed here; the prefix list is about
// which families to look at, not which values.

/* ---- 1. every class name the source could produce ------------------------ */

// The files to scan come from tailwind.config.cjs's own `content` globs, not
// from a hardcoded `src`. The content globs include
// `../../packages/shared/src/ui/**`, and a checker that assumed `src` would
// report a clean run while ignoring every shared component — the exact "clean
// because it examined nothing" failure this class of tool exists to avoid.
function scanRoots() {
  const cfg = createRequire(import.meta.url)(join(WEB, 'tailwind.config.cjs'));
  const globs = (cfg.content ?? []).filter((g) => typeof g === 'string');
  if (globs.length === 0) {
    console.error('dead-utilities: tailwind.config.cjs has no string content globs to scan');
    process.exit(2);
  }
  // Take the literal prefix before the first wildcard; the extension filter in
  // sourceFiles() does the rest. Precise glob semantics are not needed — over-
  // scanning costs a few files, under-scanning hides findings.
  return [...new Set(globs.map((g) => join(WEB, g.split('*')[0])))];
}

function sourceFiles(pathOrDir, out = []) {
  if (!existsSync(pathOrDir)) return out;
  if (!statSync(pathOrDir).isDirectory()) {
    if (/\.(tsx?|html)$/.test(pathOrDir)) out.push(pathOrDir);
    return out;
  }
  for (const entry of readdirSync(pathOrDir)) {
    const p = join(pathOrDir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|html)$/.test(entry)) out.push(p);
  }
  return out;
}

// Class names live in ordinary string literals — className="a b c", a ternary
// inside a template literal, a lookup table of tone -> classes. Rather than
// parse JSX, split the whole file on every character that can delimit a class
// name and keep the tokens that look like one.
//
// Splitting on the delimiters rather than matching quoted strings is what
// handles a template literal: `px-2 ${active ? 'text-body' : 'text-muted'}`
// contains nested quotes and an interpolation hole, and matching `...` as one
// literal yields fragments like `text-muted'` with the quote still attached.
// A class name is a run of non-delimiters, EXCEPT that a `[...]` arbitrary
// value is opaque and may contain delimiters of its own —
// shadow-[0_12px_40px_rgba(28,25,23,.18)] holds both parens and commas, and
// splitting naively reports the truncated head as a dead utility.
// `!` is NOT a delimiter: it is Tailwind's important prefix, and dropping it
// turns `!border-accent-border` into a lookup for a class the stylesheet spells
// `.\!border-accent-border` — a false positive on a utility that works.
const TOKEN = /(?:\[[^\]]*\]|[^\s"'`{}(),;=<>?&|])+/g;

// Comments are skipped, because PROSE FALSE-POSITIVES ARE HOW A CHECK GETS
// IGNORED. "every text-bearing node CodeMirror emits" in a line comment was
// reported as a dead `text-bearing` utility — a finding that looks real until
// you open the file, and the second one of those trains people to skim the
// output.
//
// Deliberately conservative. A line comment counts only when the TRIMMED line
// starts with `//`, which is what keeps the `{'// '}` eyebrow — real JSX that
// can share a line with real classes — from being treated as one.
function stripComments(lines) {
  let inBlock = false;
  return lines.map((line) => {
    let out = line;
    if (inBlock) {
      const end = out.indexOf('*/');
      if (end === -1) return '';
      out = out.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = out.indexOf('/*');
      if (start === -1) break;
      const end = out.indexOf('*/', start + 2);
      if (end === -1) {
        inBlock = true;
        out = out.slice(0, start);
        break;
      }
      out = out.slice(0, start) + out.slice(end + 2);
    }
    return out.trimStart().startsWith('//') ? '' : out;
  });
}

const candidates = new Map(); // class -> Set of "file:line"
for (const file of scanRoots().flatMap((r) => sourceFiles(r))) {
  const text = readFileSync(file, 'utf8');
  const lines = stripComments(text.split('\n'));
  lines.forEach((lineText, i) => {
    for (const cls of lineText.match(TOKEN) ?? []) {
      if (!cls) continue;
      // The base is what names the colour family; variants (hover:, last:,
      // focus-visible:) sit in front of it and are kept, because Tailwind
      // emits the variant selector as part of the class name and that is what
      // has to be looked up.
      const base = cls.slice(cls.lastIndexOf(':') + 1).replace(/^!/, '');
      const prefix = COLOUR_PREFIXES.find(
        (p) => base.startsWith(`${p}-`) || base.startsWith(`-${p}-`),
      );
      if (!prefix) continue;
      // A fragment, not a class: `text-${tone}` is half a name and the real
      // one is assembled at runtime out of a lookup table elsewhere.
      if (cls.includes('$')) continue;
      if (!candidates.has(cls)) candidates.set(cls, new Set());
      candidates.get(cls).add(`${file.replace(`${WEB}/`, '')}:${i + 1}`);
    }
  });
}

/* ---- 2. what the built stylesheet actually contains ---------------------- */

const tmp = mkdtempSync(join(tmpdir(), 'esca-tw-'));
const out = join(tmp, 'built.css');
try {
  execFileSync('npx', ['tailwindcss', '-i', ENTRY_CSS, '-o', out], {
    cwd: WEB,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const css = readFileSync(out, 'utf8');

  // Selectors as written, with Tailwind's CSS escaping removed so they compare
  // against the source spelling: .border-\[\#b91c1c\]\/40 -> border-[#b91c1c]/40
  //
  // The `\\.` branch MUST come first and the plain branch must exclude the
  // backslash. Ordered the other way, the plain branch happily consumes a lone
  // `\` and the match then stops at the `:` it was escaping, so
  // `.focus-visible\:ring-2:focus-visible` reads as `focus-visible\` — every
  // variant utility in the app is reported dead, and the report is so loud it
  // looks like a real finding.
  //
  // Two escape forms, and the numeric one has to go first. CSS escapes a comma
  // as `\2c ` — a hex code point plus ONE optional trailing space that is part
  // of the escape, not of the name. So
  // `shadow-[0_12px_40px_rgba(28,25,23,0.25)]` is written
  // `.shadow-\[0_12px_40px_rgba\(28\2c 25\2c ...` and a naive `\\(.)` unescape
  // leaves the digits behind, producing a name that matches nothing.
  const unescape = (s) =>
    s
      .replace(/\\([0-9a-fA-F]{1,6})[ ]?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\(.)/g, '$1');

  // The numeric-escape branch has to be in the MATCHER too, not just the
  // unescaper: `\2c ` ends in a space, and a matcher that treats space as a
  // selector terminator stops dead in the middle of the class name. That
  // truncates exactly the utilities whose value contains a comma — which is
  // every arbitrary rgba() shadow.
  const emitted = new Set(
    [...css.matchAll(/\.((?:\\[0-9a-fA-F]{1,6}[ ]?|\\.|\[[^\]]*\]|[^\s{},:>+~()[\]\\])+)/g)].map(
      (m) => unescape(m[1]),
    ),
  );

  // The FULL class including its variants, not the base: Tailwind writes
  // `.hover\:bg-fill-hover:hover`, so the class name in the selector is
  // `hover:bg-fill-hover`. Looking up the base alone reports every
  // hover-only utility in the app as dead.
  const dead = [];
  for (const [cls, where] of candidates) {
    if (!emitted.has(cls)) dead.push([cls, [...where]]);
  }

  if (dead.length === 0) {
    console.log(`dead-utilities: ${candidates.size} colour utilities in source, all emit CSS`);
    process.exit(0);
  }

  console.error(
    `dead-utilities: ${dead.length} of ${candidates.size} colour utilities emit NO CSS\n`,
  );
  for (const [cls, where] of dead.sort()) {
    console.error(`  ${cls}`);
    for (const w of where.sort()) console.error(`      ${w}`);
  }
  console.error(
    '\nEach of these renders as the DEFAULT for its property, not as nothing —\n' +
      'a wrong colour rather than a missing one, which is why it survives review.\n' +
      'Common causes: an opacity modifier on a var()-backed role (unsupported in\n' +
      'Tailwind 3.4 — drop it or use a token that carries the value), a colour key\n' +
      'that is not in the preset, or a typo.',
  );
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
