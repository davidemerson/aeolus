import { crc32 } from 'node:zlib';

// Minimal "store"-mode ZIP writer. Sufficient for bundling a project
// for download:
//   - Per-doc total size is capped at 200 MB (see /files/upload), so
//     the resulting archive fits comfortably in memory.
//   - "Store" mode (no compression) skips DEFLATE entirely; the
//     surface area of the format reduces to fixed-size headers + a
//     central directory + EOCD, all under 80 lines of code.
//
// Format references:
//   - APPNOTE.TXT 6.3.10 (PKWARE), local file header (4.3.7),
//     central directory (4.3.12), EOCD (4.3.16).
//   - Compression method 0 = stored (4.4.5).
//   - General-purpose bit 11 (0x0800) marks UTF-8 filenames
//     (4.4.4) — set unconditionally since paths are validated to a
//     printable ASCII subset upstream but bit 11 is harmless when
//     bytes happen to be ASCII.

export interface ZipEntry {
  // Forward-slash-separated archive path. Validated upstream by the
  // file route (no traversal, bounded segment characters).
  path: string;
  // Raw bytes; not compressed.
  data: Uint8Array;
  // Optional last-modified timestamp. Defaults to "now" — ZIP only
  // records to 2-second resolution which is fine for a bundle.
  mtime?: Date;
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const dataBuffer = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    // crc32 returns a 32-bit unsigned integer.
    const crc = crc32(dataBuffer) >>> 0;
    const size = dataBuffer.length;
    const { dosTime, dosDate } = toDosDateTime(entry.mtime ?? new Date());

    // Local file header: 30 bytes + filename.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(0x0800, 6); // flags (UTF-8 filename)
    local.writeUInt16LE(0, 8); // compression: stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localChunks.push(local, nameBytes, dataBuffer);

    // Central directory header: 46 bytes + filename.
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(0, 10); // compression: stored
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralChunks.push(central, nameBytes);

    offset += local.length + nameBytes.length + dataBuffer.length;
  }

  const localPart = Buffer.concat(localChunks);
  const centralPart = Buffer.concat(centralChunks);

  // End of central directory: 22 bytes (no archive comment).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk w/ central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralPart.length, 12); // central dir size
  eocd.writeUInt32LE(localPart.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localPart, centralPart, eocd]);
}

function toDosDateTime(d: Date): { dosTime: number; dosDate: number } {
  // MS-DOS packed time (4.4.6): seconds/2 (5b) | minute (6b) | hour (5b)
  const dosTime =
    (Math.floor(d.getSeconds() / 2) & 0x1f) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((d.getHours() & 0x1f) << 11);
  // MS-DOS packed date: day (5b) | month (4b) | year-1980 (7b)
  const yearOffset = Math.max(0, d.getFullYear() - 1980);
  const dosDate =
    (d.getDate() & 0x1f) | (((d.getMonth() + 1) & 0x0f) << 5) | ((yearOffset & 0x7f) << 9);
  return { dosTime, dosDate };
}

// Sanitize the doc title for use as the zip's basename. Mirrors the
// path validation used by the file routes (printable ASCII subset)
// so the suggested filename never contains anything a browser would
// have to escape. Falls back to the doc id when the title contains
// nothing usable.
export function safeFilename(title: string, fallback: string): string {
  const cleaned = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}
