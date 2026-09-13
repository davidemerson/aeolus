export interface ParsedCookie {
  name: string;
  value: string;
}

export function parseSetCookie(raw: string): ParsedCookie | null {
  const first = raw.split(';')[0];
  if (!first) return null;
  const idx = first.indexOf('=');
  if (idx < 0) return null;
  return { name: first.slice(0, idx).trim(), value: first.slice(idx + 1).trim() };
}
