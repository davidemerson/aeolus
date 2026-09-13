import fastifyCookie from '@fastify/cookie';

import { sessionConstants } from '@aeolus/auth';

export interface CookieUnsigner {
  unsign(signed: string): { valid: boolean; value: string | null };
}

export function createCookieUnsigner(secret: string): CookieUnsigner {
  const signer = fastifyCookie.signerFactory(secret);
  return {
    unsign(signed: string) {
      const result = signer.unsign(signed);
      return { valid: result.valid, value: result.value };
    },
  };
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(value);
  }
  return out;
}

export function extractSessionToken(
  cookieHeader: string | undefined,
  unsigner: CookieUnsigner,
): string | null {
  const cookies = parseCookieHeader(cookieHeader);
  const signed = cookies[sessionConstants.COOKIE_NAME];
  if (!signed) return null;
  const unsigned = unsigner.unsign(signed);
  if (!unsigned.valid || unsigned.value === null) return null;
  return unsigned.value;
}
