import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { parseSynctex } from './synctex.js';

// Synthetic synctex sample matching the format Tectonic / pdflatex
// emit: a header listing input files, a Content marker, then a tree
// of page / box records. Box records are `(F,L:H,V:W,Hb,Vb` —
// comma-and-colon separated, mirroring real-world output.
const SAMPLE = `SyncTeX Version:1
Input:1:./main.tex
Input:2:./chapters/intro.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,5:472,472:472,6444404,1683096
(1,5:472,472:472,6444404,1683096
h0,5:472,1183932:472,1683096,51260
)
(1,7:472,2000000:472,1683096,60000
)
[2,3:472,3000000:472,1683096,51260
(2,3:472,3000000:472,1683096,51260
)
]
]
}
{2
[1,42:472,472:472,6444404,1683096
(1,42:472,472:472,6444404,1683096
)
]
}
`;

describe('parseSynctex', () => {
  it('parses a textual synctex sample into forward and reverse maps', () => {
    const map = parseSynctex(SAMPLE);
    expect(map.version).toBe(1);
    expect(map.files.sort()).toEqual(['chapters/intro.tex', 'main.tex']);

    // Forward: main.tex line 5 → page 1.
    const main = map.forward['main.tex'];
    expect(main.find((b) => b.line === 5)?.page).toBe(1);
    expect(main.find((b) => b.line === 7)?.page).toBe(1);
    expect(main.find((b) => b.line === 42)?.page).toBe(2);
    // Sorted by line ascending.
    expect(main.map((b) => b.line)).toEqual([5, 5, 7, 42, 42]);

    // chapters/intro.tex line 3 also lives on page 1.
    expect(map.forward['chapters/intro.tex'].find((b) => b.line === 3)?.page).toBe(1);

    // Reverse: page 1 has records sorted by y ascending.
    const page1 = map.reverse[1];
    expect(page1.length).toBeGreaterThan(0);
    expect(page1.every((b, i, arr) => i === 0 || arr[i - 1].y <= b.y)).toBe(true);
    // Page 2 has only the line-42 main.tex record.
    expect(map.reverse[2].map((b) => b.line)).toEqual([42, 42]);
  });

  it('accepts gzipped input transparently', () => {
    const gz = gzipSync(Buffer.from(SAMPLE, 'utf8'));
    const map = parseSynctex(gz);
    expect(map.files).toContain('main.tex');
    expect(map.forward['main.tex'].some((b) => b.line === 7)).toBe(true);
  });

  it('ignores leading "./" tectonic prepends to the entry filename', () => {
    const map = parseSynctex(SAMPLE);
    // Both input names had a "./" prefix in the source text — they
    // should normalize.
    expect(map.files).not.toContain('./main.tex');
    expect(map.files).toContain('main.tex');
  });

  it('strips workdir prefixes from absolute Input: paths', () => {
    const abs = `SyncTeX Version:1
Input:1:/private/var/folders/cf/abc/T/tmp.AbC/main.tex
Output:pdf
Content:
{1
(1,5:472,472:472,6444404,1683096
)
}
`;
    const map = parseSynctex(abs);
    expect(map.files).toEqual(['main.tex']);
    expect(map.forward['main.tex'].length).toBe(1);
  });

  it('skips empty Input: placeholder lines', () => {
    const placeholders = `SyncTeX Version:1
Input:1:/tmp/main.tex
Input:2:
Input:3:
Content:
{1
(1,5:472,472:472,6444404,1683096
)
}
`;
    const map = parseSynctex(placeholders);
    expect(map.files).toEqual(['main.tex']);
  });

  it('returns empty indexes for a file with no Content section', () => {
    const map = parseSynctex('SyncTeX Version:1\nInput:1:foo.tex\n');
    expect(map.files).toEqual(['foo.tex']);
    expect(map.forward).toEqual({});
    expect(map.reverse).toEqual({});
  });
});
