import { gunzipSync } from 'node:zlib';

// SyncTeX format reference: J. Laurens, "synctex — A synchronization
// tool for tex" (the spec PDF distributed with TeX Live). The format
// is text, line-oriented, with a small header followed by `Content:`
// and a tree of page / box / glue records.
//
// We only parse what's needed to drive forward (source → PDF page+y)
// and reverse (PDF page+y → source line) lookups in the editor:
//   - Input:N:filename     (file id → name)
//   - {N ... }             (page open / close)
//   - (F,L:H:V:W:Hb:Vb     (horizontal box: file F, line L, at sp coords)
//   - [F,L:H:V:W:Hb:Vb     (vertical box: same shape)
// Glue, kerns, and the zero-content [0,0:...] anchors are ignored.

export interface SynctexBox {
  file: string;
  line: number;
  page: number;
  // sp = scaled points; 1 pt = 65536 sp. Kept as integers for fidelity.
  // Y is measured from the top of the page in synctex's coordinate
  // system after applying Y Offset.
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SynctexMap {
  version: 1;
  // Discovered file paths (Input:N:filename), in encounter order.
  files: string[];
  // Forward index: file → records sorted by line ascending. The
  // editor picks the first record with line >= target.
  forward: Record<string, SynctexBox[]>;
  // Reverse index: page (1-based) → records on that page sorted by
  // y. The PDF.js click handler picks the closest box on that page.
  reverse: Record<number, SynctexBox[]>;
}

// Box record format (per synctex spec): `(F,L:H,V:W,Hb,Vb` or
// `[F,L:H,V:W,Hb,Vb` — F is file id, L is line, H/V are scaled-point
// coords, W/Hb/Vb are width and box height/depth. Separators are
// comma + colon as shown; older tooling sometimes documents these
// as all-colon, but tectonic / pdflatex emit the comma-mixed form.
const RECORD_RE = /^[(\[](\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/;
const INPUT_RE = /^Input:(\d+):(.+)$/;

// Parse a synctex file. Accepts either the raw text (as a string or
// Buffer) or the gzipped form (the .synctex.gz tectonic emits).
export function parseSynctex(input: Buffer | string): SynctexMap {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    // gzip magic: 0x1f 0x8b. Tectonic always gzips synctex output.
    text =
      input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b
        ? gunzipSync(input).toString('utf8')
        : input.toString('utf8');
  }

  const files: string[] = [];
  const fileById = new Map<number, string>();
  const forward: Record<string, SynctexBox[]> = {};
  const reverse: Record<number, SynctexBox[]> = {};

  const pageStack: number[] = [];
  let inContent = false;

  for (const line of text.split('\n')) {
    if (!inContent) {
      const im = INPUT_RE.exec(line);
      if (im) {
        const id = Number(im[1]);
        const raw = im[2];
        // Empty Input lines (Tectonic emits "Input:N:" placeholders
        // before resolving) → ignore. Absolute paths → keep just
        // the basename so multi-file projects can address files by
        // their project-relative name. Relative paths → strip the
        // leading "./" tectonic prepends.
        let name: string | null = null;
        if (raw.length > 0) {
          if (raw.startsWith('/')) {
            const idx = raw.lastIndexOf('/');
            name = idx === -1 ? raw : raw.slice(idx + 1);
          } else {
            name = raw.replace(/^\.\//, '');
          }
        }
        if (name && !fileById.has(id)) {
          fileById.set(id, name);
          files.push(name);
        }
        continue;
      }
      if (line === 'Content:') {
        inContent = true;
        continue;
      }
      continue;
    }

    // Page open: `{P` (P is 1-based page number).
    if (line.length > 1 && line[0] === '{') {
      const p = Number(line.slice(1));
      if (Number.isFinite(p) && p >= 1) {
        pageStack.push(p);
      }
      continue;
    }
    // Page close: a single `}` on its own line.
    if (line === '}' || line.startsWith('}')) {
      pageStack.pop();
      continue;
    }
    // Box record: `(F,L:H:V:W:Hb:Vb` or `[F,L:H:V:W:Hb:Vb`. There
    // are also closers `)`/`]` which carry no useful coords for us.
    const rm = RECORD_RE.exec(line);
    if (!rm) continue;
    const fileId = Number(rm[1]);
    const lineNum = Number(rm[2]);
    if (!Number.isFinite(fileId) || !Number.isFinite(lineNum) || lineNum <= 0) {
      continue;
    }
    const name = fileById.get(fileId);
    if (!name) continue;
    const page = pageStack[pageStack.length - 1] ?? 1;
    const box: SynctexBox = {
      file: name,
      line: lineNum,
      page,
      x: Number(rm[3]),
      y: Number(rm[4]),
      w: Number(rm[5]),
      h: Number(rm[7]), // Vbox (bounding height); Hbox (rm[6]) ignored.
    };
    (forward[name] ??= []).push(box);
    (reverse[page] ??= []).push(box);
  }

  // Sort forward by line, reverse by y, so consumers can binary-
  // search / linear-scan deterministically.
  for (const k of Object.keys(forward)) {
    forward[k].sort((a, b) => a.line - b.line || a.y - b.y);
  }
  for (const k of Object.keys(reverse)) {
    reverse[Number(k)].sort((a, b) => a.y - b.y);
  }

  return { version: 1, files, forward, reverse };
}
