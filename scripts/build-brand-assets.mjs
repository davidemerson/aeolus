#!/usr/bin/env node
// Generates every brand asset from one description of the mark.
//
//   node scripts/build-brand-assets.mjs           write the files
//   node scripts/build-brand-assets.mjs --check   fail if they are stale
//
// The outputs are committed, not built in CI: a browser tab icon should not
// depend on a native canvas binding being installable on someone's machine.
// This script exists so they can be regenerated identically when the mark or
// the palette changes, and so the SVG and the PNGs cannot drift apart — both
// are drawn from the MARK object below, the SVG by emitting its paths and the
// PNGs by replaying the same path strings through Path2D.
//
// Needs @napi-rs/canvas, which is a devDependency of apps/web.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GlobalFonts, createCanvas, Path2D } from '@napi-rs/canvas';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'apps/web/public');
// electron-builder derives every platform's installer icon from this one file.
const ELECTRON_ICON = join(ROOT, 'apps/electron/build/icon.png');
const CHECK = process.argv.includes('--check');

// Palette, kept in step with apps/web/tailwind.preset.cjs. Not imported from
// it: this file is the one place the mark's own colours are decided, and a
// silent change to a UI token should not restyle the favicon.
const TEAL_DEEP = '#0c6d73';
const TEAL = '#17a2a4';
const TEAL_BRIGHT = '#31b8b8';
const PALE = '#effbfa';
const INK = '#082b30';

/**
 * The Aeolus mark, on a 64×64 grid.
 *
 * Three strokes of moving air, the top one lifting into a curl. Read large it
 * is a gust; read at 16px it is three bars, which is the size a favicon has to
 * survive — hence round caps, generous spacing, and nothing anywhere in it
 * finer than the stroke width.
 */
const MARK = {
  size: 64,
  // The tile the strokes sit on. Radius 14 of 64 matches the app's card
  // radius scaled up, so the mark and the UI agree about how round things are.
  tile: { x: 2, y: 2, width: 60, height: 60, radius: 14 },
  strokeWidth: 5.5,
  strokes: [
    // Top: lifts at its end, which is the whole idea of the mark. The hook
    // stops well clear of the stroke below it — at 16px anything closer
    // merges into a blob.
    'M 14 23 H 32 C 39.5 23 39.5 12 31 12',
    // Middle: the long one.
    'M 14 34 H 45',
    // Bottom: shortest, so the silhouette tapers.
    'M 14 45 H 29',
  ],
};

/** A rounded rectangle as an SVG path, so the SVG and the canvas agree. */
function roundedRectPath({ x, y, width, height, radius }) {
  const r = radius;
  return [
    `M ${x + r} ${y}`,
    `H ${x + width - r}`,
    `A ${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V ${y + height - r}`,
    `A ${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + height - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/**
 * The mark as an SVG document.
 *
 * `padded` insets the artwork, which is what a maskable icon needs: the OS
 * crops to a circle inscribed in the safe zone and anything outside it is
 * gone. `tile: false` drops the background for use on a surface that already
 * has one.
 */
function markSvg({ px = 64, tile = true, padding = 0 } = {}) {
  const scale = (MARK.size - padding * 2) / MARK.size;
  const inner = [
    tile ? `<path d="${roundedRectPath(MARK.tile)}" fill="url(#g)"/>` : '',
    ...MARK.strokes.map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${tile ? PALE : TEAL}" ` +
        `stroke-width="${MARK.strokeWidth}" stroke-linecap="round"/>`,
    ),
  ]
    .filter(Boolean)
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK.size} ${MARK.size}" width="${px}" height="${px}" role="img" aria-label="Aeolus">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TEAL_BRIGHT}"/>
      <stop offset="1" stop-color="${TEAL_DEEP}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${padding} ${padding}) scale(${scale})">
    ${inner}
  </g>
</svg>
`;
}

/** The same mark, drawn onto a canvas context scaled to `px`. */
function drawMark(ctx, px, { tile = true, padding = 0, background = null } = {}) {
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  ctx.save();
  const scale = px / MARK.size;
  ctx.scale(scale, scale);
  const inset = (padding / px) * MARK.size;
  ctx.translate(inset, inset);
  const shrink = (MARK.size - inset * 2) / MARK.size;
  ctx.scale(shrink, shrink);

  if (tile) {
    const gradient = ctx.createLinearGradient(0, 0, 0, MARK.size);
    gradient.addColorStop(0, TEAL_BRIGHT);
    gradient.addColorStop(1, TEAL_DEEP);
    ctx.fillStyle = gradient;
    ctx.fill(new Path2D(roundedRectPath(MARK.tile)));
  }

  ctx.strokeStyle = tile ? PALE : TEAL;
  ctx.lineWidth = MARK.strokeWidth;
  ctx.lineCap = 'round';
  for (const d of MARK.strokes) ctx.stroke(new Path2D(d));
  ctx.restore();
}

function pngOfMark(px, options = {}) {
  const canvas = createCanvas(px, px);
  drawMark(canvas.getContext('2d'), px, options);
  return canvas.toBuffer('image/png');
}

/**
 * An ICO wrapping a single PNG. Every browser and Windows version still in
 * service reads PNG-in-ICO, and the alternative is a BMP encoder for one
 * legacy container.
 */
function icoOfPng(png, px) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(px >= 256 ? 0 : px, 0); // width, 0 meaning 256
  entry.writeUInt8(px >= 256 ? 0 : px, 1); // height
  entry.writeUInt8(0, 2); // palette size
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

/** The link-preview card: the mark, the name, and one line of what it is. */
function ogImage() {
  const width = 1200;
  const height = 630;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, INK);
  background.addColorStop(1, '#0e3a40');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // The mark, large, on the left.
  ctx.save();
  ctx.translate(120, 195);
  drawMark(ctx, 240);
  ctx.restore();

  const fontPath = join(PUBLIC, 'fonts/Jost-latin.woff2');
  const registered = GlobalFonts.registerFromPath(fontPath, 'AeolusBrand');
  // If the face will not load, fall back rather than emit a card in a
  // system font that differs per machine and makes --check flap.
  const family = registered ? 'AeolusBrand' : 'sans-serif';

  ctx.fillStyle = PALE;
  ctx.font = `600 96px ${family}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Aeolus', 420, 320);

  ctx.fillStyle = TEAL_BRIGHT;
  ctx.font = `400 34px ${family}`;
  ctx.fillText('Collaborative LaTeX and Typst editor', 420, 380);

  ctx.fillStyle = 'rgba(239, 251, 250, 0.55)';
  ctx.font = `400 26px ${family}`;
  ctx.fillText('Self-hosted. AGPL-3.0.', 420, 430);

  return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------------------

const outputs = new Map([
  // The scalable one every modern browser prefers.
  ['favicon.svg', Buffer.from(markSvg({ px: 64 }), 'utf8')],
  // The same mark without its tile, for use inside the app's own chrome where
  // a coloured square would fight the surface.
  ['aeolus-mark.svg', Buffer.from(markSvg({ px: 64, tile: false }), 'utf8')],
  ['favicon-32.png', pngOfMark(32)],
  ['apple-touch-icon.png', pngOfMark(180)],
  ['icon-192.png', pngOfMark(192)],
  ['icon-512.png', pngOfMark(512)],
  // Maskable icons are cropped to a circle by the OS, so the artwork is inset
  // into the safe zone (the middle 80%) and the tile bleeds to the edge.
  ['icon-192-maskable.png', pngOfMark(192, { padding: 19, background: TEAL_DEEP })],
  ['icon-512-maskable.png', pngOfMark(512, { padding: 51, background: TEAL_DEEP })],
  ['favicon.ico', icoOfPng(pngOfMark(32), 32)],
  ['og-image.png', ogImage()],
]);

// Written outside apps/web/public, so it is keyed by absolute path.
const elsewhere = new Map([[ELECTRON_ICON, pngOfMark(1024)]]);

const label = (path) => path.slice(ROOT.length);
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 12);
const stale = [];

for (const [name, buffer] of [
  ...[...outputs].map(([name, buffer]) => [join(PUBLIC, name), buffer]),
  ...elsewhere,
]) {
  const path = name;
  if (CHECK) {
    if (!existsSync(path)) {
      stale.push(`${label(name)} is missing`);
    } else if (digest(readFileSync(path)) !== digest(buffer)) {
      stale.push(`${label(name)} differs from what this script produces`);
    }
  } else {
    writeFileSync(path, buffer);
    console.log(
      `  ${label(name).padEnd(30)} ${String(buffer.length).padStart(8)} bytes  ${digest(buffer)}`,
    );
  }
}

if (CHECK) {
  if (stale.length > 0) {
    console.error('build-brand-assets --check: the committed assets are stale\n');
    for (const line of stale) console.error(`  ${line}`);
    console.error('\nRun: node scripts/build-brand-assets.mjs');
    process.exit(1);
  }
  console.log('build-brand-assets: committed assets match');
} else {
  console.log(`\nWrote ${outputs.size + elsewhere.size} files.`);
}
