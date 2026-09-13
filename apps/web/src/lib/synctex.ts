// SyncTeX client helpers. Mirrors the parsed-map shape produced by
// the worker (apps/compile-worker/src/synctex.ts) and provides the
// forward / reverse lookups the editor uses.

export interface SynctexBox {
  file: string;
  line: number;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SynctexMap {
  version: 1;
  files: string[];
  forward: Record<string, SynctexBox[]>;
  reverse: Record<number, SynctexBox[]>;
}

// 1 pt = 65536 sp. SyncTeX coordinates are in scaled points.
const SP_PER_PT = 65536;

// Forward jump: pick the synctex box for a given (file, line). The
// stored array is sorted by line ascending; we want the first record
// at-or-after the target line so a click on a comment line still
// lands on the next typeset record.
export function findForwardTarget(map: SynctexMap, file: string, line: number): SynctexBox | null {
  // Match the file by suffix so 'main.tex' and 'chapters/intro.tex'
  // both work whether the synctex source paths are relative or
  // workdir-qualified.
  let candidates: SynctexBox[] | undefined = map.forward[file];
  if (!candidates || candidates.length === 0) {
    const matchKey = Object.keys(map.forward).find(
      (k) => k === file || k.endsWith(`/${file}`) || file.endsWith(`/${k}`),
    );
    if (!matchKey) return null;
    candidates = map.forward[matchKey];
  }
  if (!candidates) return null;
  for (const box of candidates) {
    if (box.line >= line) return box;
  }
  // Fall back to the last box if the line is past the end of the
  // typeset content (e.g. clicking inside an empty trailing line).
  return candidates[candidates.length - 1] ?? null;
}

// Reverse jump: given a click on a rendered PDF page at (x, y) in
// PDF points (origin top-left), find the closest synctex box. We
// sort by squared distance to the box's (x, y) anchor since the box
// dimensions don't constrain in practice (most boxes have the same
// height for a given page).
export function findReverseTarget(
  map: SynctexMap,
  page: number,
  pdfX: number,
  pdfY: number,
): SynctexBox | null {
  const candidates = map.reverse[page];
  if (!candidates || candidates.length === 0) return null;

  const targetX = pdfX * SP_PER_PT;
  const targetY = pdfY * SP_PER_PT;
  let best: SynctexBox | null = null;
  let bestDist = Infinity;
  for (const box of candidates) {
    const dx = box.x - targetX;
    const dy = box.y - targetY;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = box;
    }
  }
  return best;
}
