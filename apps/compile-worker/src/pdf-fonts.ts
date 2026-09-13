// Find fonts a compiled PDF references but does not embed (#80).
//
// A font whose OS/2 `fsType` forbids subsetting (0x0100) cannot be
// subset-embedded by xdvipdfmx, so Tectonic writes a *named, non-embedded*
// reference and says nothing — at any verbosity. The in-app previewer
// (PDF.js) then substitutes a fallback font from the width tables, so the
// document "looks fine", while Acrobat and macOS Preview cannot substitute
// a non-embedded Identity-H CID font and drop the glyphs: every span set in
// that face reads as redacted. The failure was silent end to end. This closes
// the silence: after a successful compile the worker scans the PDF and
// records a warning per non-embedded font, which the editor surfaces.
//
// Dependency-free by design: a PDF font is embedded iff its FontDescriptor
// carries a /FontFile, /FontFile2 or /FontFile3 stream reference, so this
// only needs to see every FontDescriptor dictionary. Those live either as
// plain objects in the file body or inside compressed object streams
// (/Type /ObjStm, FlateDecode — what xdvipdfmx writes by default), which
// Node's zlib inflates. Anything this cannot parse contributes nothing: a
// scan failure must never fail a compile that succeeded.

import { inflateSync } from 'node:zlib';

// Standard 14 fonts are never embedded and every reader ships them; the
// warning is about fonts the recipient will not have.
const STANDARD_14 = new Set([
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
]);

const FONT_DESCRIPTOR_RE = /\/Type\s*\/FontDescriptor/g;
const FONT_NAME_RE = /\/FontName\s*\/([^\s/<>[\]()]+)/;
const FONT_FILE_RE = /\/FontFile[23]?\b/;

// Latin-1 keeps every byte a single char, so byte offsets stay usable
// as string indices and the PDF's ASCII syntax is intact.
function latin1(buf: Buffer): string {
  return buf.toString('latin1');
}

// Inflate every FlateDecode stream (object streams hold the font
// descriptors in a compressed file) and append its decoded text to the
// scannable corpus. Non-Flate or corrupt streams are skipped.
function inflatedStreams(pdf: Buffer): string[] {
  const text = latin1(pdf);
  const out: string[] = [];
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(text)) !== null) {
    const dictStart = text.lastIndexOf('<<', m.index);
    const dict = dictStart >= 0 ? text.slice(dictStart, m.index) : '';
    if (!/\/FlateDecode/.test(dict)) continue;
    const dataStart = m.index + m[0].length;
    const end = text.indexOf('endstream', dataStart);
    if (end < 0) break;
    let dataEnd = end;
    while (dataEnd > dataStart && (text[dataEnd - 1] === '\n' || text[dataEnd - 1] === '\r')) {
      dataEnd -= 1;
    }
    try {
      out.push(latin1(inflateSync(pdf.subarray(dataStart, dataEnd))));
    } catch {
      // Not ours to decode (encrypted, predictor-tagged binary, corrupt).
    }
    streamRe.lastIndex = end;
  }
  return out;
}

// Extract the dictionary that starts at the `<<` enclosing `at`, honouring
// nesting, so a descriptor's own keys are examined and not its neighbours'.
function enclosingDict(text: string, at: number): string {
  const start = text.lastIndexOf('<<', at);
  if (start < 0) return '';
  // Walk outward if `at` sits inside a nested dict of the descriptor.
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth += 1;
      i += 1;
    } else if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

// Strip a subset prefix ("ABCDEF+Name" -> "Name") for the human message.
function displayName(fontName: string): string {
  return fontName.replace(/^[A-Z]{6}\+/, '');
}

export function findNonEmbeddedFonts(pdf: Buffer): string[] {
  const corpora = [latin1(pdf), ...inflatedStreams(pdf)];
  const missing = new Set<string>();
  for (const text of corpora) {
    FONT_DESCRIPTOR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FONT_DESCRIPTOR_RE.exec(text)) !== null) {
      const dict = enclosingDict(text, m.index);
      if (!dict) continue;
      if (FONT_FILE_RE.test(dict)) continue;
      const name = FONT_NAME_RE.exec(dict)?.[1];
      if (!name) continue;
      const shown = displayName(name);
      if (STANDARD_14.has(shown)) continue;
      missing.add(shown);
    }
  }
  return [...missing].sort();
}

// The warnings recorded on the compile result. One line per font, worded
// for the author who is about to send the PDF to someone else.
export function fontEmbeddingWarnings(pdf: Buffer): string[] {
  let fonts: string[];
  try {
    fonts = findNonEmbeddedFonts(pdf);
  } catch {
    return [];
  }
  return fonts.map(
    (f) =>
      `Font "${f}" is not embedded in the PDF — it will display as blank or substituted text on any machine that does not have it installed (the in-app preview substitutes it, so it looks fine here). Usually the font's licence flag forbids subsetting; use an embeddable build or a different font.`,
  );
}
