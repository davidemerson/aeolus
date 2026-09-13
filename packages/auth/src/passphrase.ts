import {
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

import { WORDLIST } from './wordlist.js';

// promisify's bundled overloads for scrypt stop at (password, salt, keylen),
// so the options argument needs the shape spelled out here.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// Aeolus authenticates people with a passphrase, not a password. The
// difference is not marketing: the policy below asks for length and word
// count and asks for nothing else, which is what NIST SP 800-63B has
// recommended since 2017. No character classes, no expiry, no hints — those
// rules push people toward `P@ssw0rd!` and a sticky note.
//
// Storage is scrypt from node:crypto. Argon2id would be the modern first
// choice, but every Node binding for it is a native module, and a native
// module is a build that can fail on someone's architecture. scrypt is
// memory-hard, in the standard library, and available on every platform this
// runs on. The parameters are stored beside each hash so they can be raised
// later without invalidating anyone's credential.

/** ~64 MB per hash: N=2^15, r=8. Raising N later is safe — verify reads the stored value. */
export const SCRYPT_N = 32_768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export const PASSPHRASE_MIN_LENGTH = 16;
export const PASSPHRASE_MIN_WORDS = 4;
/** A long random string from a password manager is fine without being wordy. */
export const PASSPHRASE_LONG_ENOUGH = 24;
export const PASSPHRASE_MAX_LENGTH = 1024;

/** The single sentence the UI shows. Keep it and the checks below in step. */
export const PASSPHRASE_RULE =
  'At least 16 characters: four or more words, or a single string of 24 or more characters.';

// Rejected outright. Everything here already passes the length rule, which is
// the point — `password` is caught by length, `passwordpassword` is not.
// Keyboard walks and the famous example passphrases are the realistic
// low-entropy choices at this length.
const DENYLIST = new Set([
  'correcthorsebatterystaple',
  'passwordpassword',
  'passwordpassword1',
  'password123456789',
  'letmeinletmein',
  'administratoradministrator',
  'qwertyuiopasdfgh',
  'qwertyuiopasdfghjkl',
  'asdfghjklasdfghjkl',
  'zxcvbnmzxcvbnm',
  'qwertyqwertyqwerty',
  'abcdefghijklmnop',
  'aaaaaaaaaaaaaaaa',
  'thequickbrownfoxjumpsoverthelazydog',
  'loremipsumdolorsitamet',
  'iloveyouiloveyou',
  'trustno1trustno1',
  'changemechangeme',
  'defaultpassphrase',
  'aeolusaeolusaeolus',
  'thisisapassphrase',
  'mysecretpassphrase',
]);

const KEYBOARD_ROWS = [
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '1234567890',
  'abcdefghijklmnopqrstuvwxyz',
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/** "abcabcabcabc" and "aaaaaaaa" carry a few bits however long they are. */
function isRepeatedUnit(value: string): boolean {
  const v = normalize(value);
  if (v.length < 8) return false;
  for (let unit = 1; unit <= Math.floor(v.length / 2); unit += 1) {
    if (v.length % unit !== 0) continue;
    const head = v.slice(0, unit);
    if (head.repeat(v.length / unit) === v) return true;
  }
  return false;
}

/** A run of 8+ characters straight off one keyboard row, forwards or back. */
function hasLongKeyboardRun(value: string): boolean {
  const v = normalize(value);
  for (const row of KEYBOARD_ROWS) {
    const back = [...row].reverse().join('');
    for (let i = 0; i + 8 <= row.length; i += 1) {
      if (v.includes(row.slice(i, i + 8))) return true;
    }
    for (let i = 0; i + 8 <= back.length; i += 1) {
      if (v.includes(back.slice(i, i + 8))) return true;
    }
  }
  return false;
}

/** Every distinct word repeated: "north north north north" is four words and ~10 bits. */
function tooFewDistinctWords(value: string): boolean {
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length >= PASSPHRASE_MIN_WORDS && new Set(words).size < PASSPHRASE_MIN_WORDS;
}

export interface PassphraseCheck {
  ok: boolean;
  /** Sentences, in the order they should be shown. Empty when ok. */
  problems: string[];
}

export interface PassphraseContext {
  email?: string;
  name?: string | null;
}

/**
 * The whole policy, in one place, with no side effects — so the API, the SPA's
 * error text and the tests all agree on what is acceptable.
 */
export function checkPassphrase(candidate: string, ctx: PassphraseContext = {}): PassphraseCheck {
  const problems: string[] = [];
  const value = candidate ?? '';

  if (value.length > PASSPHRASE_MAX_LENGTH) {
    return { ok: false, problems: [`Keep it under ${PASSPHRASE_MAX_LENGTH} characters.`] };
  }
  if (value.trim().length !== value.length) {
    problems.push('Remove the leading or trailing spaces.');
  }
  if (value.length < PASSPHRASE_MIN_LENGTH) {
    problems.push(
      `Use at least ${PASSPHRASE_MIN_LENGTH} characters — this one has ${value.length}.`,
    );
  } else if (wordCount(value) < PASSPHRASE_MIN_WORDS && value.length < PASSPHRASE_LONG_ENOUGH) {
    problems.push(
      `Use ${PASSPHRASE_MIN_WORDS} or more words, or make it ${PASSPHRASE_LONG_ENOUGH} characters or longer.`,
    );
  }
  if (tooFewDistinctWords(value)) {
    problems.push('Use different words — repeating one adds nothing.');
  }
  if (DENYLIST.has(normalize(value))) {
    problems.push('That is a well-known phrase. Choose something only you would pick.');
  }
  if (isRepeatedUnit(value)) {
    problems.push('Repeating the same characters adds nothing. Choose something less regular.');
  }
  if (hasLongKeyboardRun(value)) {
    problems.push('Avoid long runs straight off the keyboard.');
  }
  const local = (ctx.email ?? '').split('@')[0];
  const haystack = normalize(value);
  if (local.length >= 4 && haystack.includes(normalize(local))) {
    problems.push('Do not build it out of your email address.');
  }
  if (ctx.name && ctx.name.length >= 4 && haystack.includes(normalize(ctx.name))) {
    problems.push('Do not build it out of your own name.');
  }
  if (haystack.includes('aeolus')) {
    problems.push('Do not build it out of the name of this application.');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * A random passphrase from the EFF short wordlist. Six words is ~62 bits —
 * enough for the bootstrap credential, which exists only until the first
 * sign-in forces a real one.
 */
export function generatePassphrase(words = 6): string {
  const picked: string[] = [];
  for (let i = 0; i < words; i += 1) {
    picked.push(WORDLIST[randomInt(WORDLIST.length)]);
  }
  return picked.join(' ');
}

/** `scrypt$N$r$p$salt$hash`, all base64url. Parameters travel with the hash. */
export async function hashPassphrase(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Constant-time verify against a stored hash. Returns false rather than
 * throwing on a malformed record: a corrupt row must not be a 500 on the login
 * route, and it must not be distinguishable from a wrong passphrase.
 */
export async function verifyPassphrase(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters rather than letting a poisoned row allocate the
  // heap: 2^20 * 8 * 128 is already 1 GB.
  if (N < 1024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashRaw, 'base64url');
    actual = await scrypt(
      plain.normalize('NFKC'),
      Buffer.from(saltRaw, 'base64url'),
      expected.length,
      { N, r, p, maxmem: 128 * N * r * 2 },
    );
  } catch {
    return false;
  }
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** True when a stored hash was made with weaker parameters than the current ones. */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_N || Number(parts[2]) < SCRYPT_R;
}
