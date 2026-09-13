import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { findNonEmbeddedFonts, fontEmbeddingWarnings } from './pdf-fonts.js';

// Hand-built PDF bodies. Only the object syntax matters to the scanner —
// no xref, no trailer — which mirrors how it treats a real file: as a
// byte corpus of dictionaries, plus whatever the Flate streams inflate to.
const embedded = `
5 0 obj
<< /Type /FontDescriptor /FontName /IHAIZV+LibertinusSerif-Bold /Flags 4 /FontBBox [0 0 1 1] /FontFile3 9 0 R >>
endobj
`;
const notEmbedded = `
6 0 obj
<< /Type /FontDescriptor /FontName /IosevkaCustomXYZW-Regular /Flags 4 /FontBBox [0 0 1 1] /ItalicAngle 0 >>
endobj
`;
const standard14 = `
7 0 obj
<< /Type /FontDescriptor /FontName /Helvetica /Flags 32 /FontBBox [0 0 1 1] >>
endobj
`;
// Nested dict inside the descriptor (a /Style entry) must not hide the
// missing FontFile behind a premature `>>`.
const nestedNotEmbedded = `
8 0 obj
<< /Type /FontDescriptor /FontName /ABCDEF+NotoSerifDisplay /Style << /Panose <0102> >> /Flags 4 >>
endobj
`;

function pdf(...bodies: string[]): Buffer {
  return Buffer.from(`%PDF-1.5\n${bodies.join('\n')}\n%%EOF\n`, 'latin1');
}

function objStm(inner: string): string {
  const data = deflateSync(Buffer.from(inner, 'latin1'));
  return `10 0 obj\n<< /Type /ObjStm /N 1 /First 0 /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString('latin1')}\nendstream\nendobj\n`;
}

describe('findNonEmbeddedFonts', () => {
  it('returns nothing when every descriptor carries a FontFile', () => {
    expect(findNonEmbeddedFonts(pdf(embedded))).toEqual([]);
  });

  it('names a descriptor with no FontFile, stripping the subset prefix', () => {
    expect(findNonEmbeddedFonts(pdf(embedded, notEmbedded, nestedNotEmbedded))).toEqual([
      'IosevkaCustomXYZW-Regular',
      'NotoSerifDisplay',
    ]);
  });

  it('ignores the standard 14 fonts, which are never embedded', () => {
    expect(findNonEmbeddedFonts(pdf(standard14))).toEqual([]);
  });

  it('looks inside FlateDecode object streams, where xdvipdfmx puts descriptors', () => {
    expect(findNonEmbeddedFonts(pdf(objStm(notEmbedded)))).toEqual(['IosevkaCustomXYZW-Regular']);
    expect(findNonEmbeddedFonts(pdf(objStm(embedded)))).toEqual([]);
  });

  it('dedupes a font referenced from several descriptors', () => {
    expect(findNonEmbeddedFonts(pdf(notEmbedded, objStm(notEmbedded)))).toEqual([
      'IosevkaCustomXYZW-Regular',
    ]);
  });

  it('treats a corrupt stream as nothing to report', () => {
    const broken = `11 0 obj\n<< /Length 5 /Filter /FlateDecode >>\nstream\nxxxxx\nendstream\nendobj\n`;
    expect(findNonEmbeddedFonts(pdf(broken, embedded))).toEqual([]);
  });
});

describe('fontEmbeddingWarnings', () => {
  it('produces one author-facing line per missing font, none when all embed', () => {
    expect(fontEmbeddingWarnings(pdf(embedded))).toEqual([]);
    const w = fontEmbeddingWarnings(pdf(notEmbedded));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"IosevkaCustomXYZW-Regular" is not embedded');
    expect(w[0]).toMatch(/looks fine here/);
  });

  it('never throws on garbage input', () => {
    expect(fontEmbeddingWarnings(Buffer.from([0, 1, 2, 3]))).toEqual([]);
    expect(fontEmbeddingWarnings(Buffer.alloc(0))).toEqual([]);
  });
});
