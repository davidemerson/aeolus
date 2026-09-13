import { describe, expect, it } from 'vitest';

import {
  PASSPHRASE_MAX_LENGTH,
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_RULE,
  SCRYPT_N,
  checkPassphrase,
  generatePassphrase,
  hashPassphrase,
  needsRehash,
  verifyPassphrase,
} from './passphrase.js';
import { WORDLIST } from './wordlist.js';

const GOOD = 'wander plaza tundra kelp bicycle';

describe('checkPassphrase — what it accepts', () => {
  it('accepts four or more words', () => {
    expect(checkPassphrase(GOOD)).toEqual({ ok: true, problems: [] });
  });

  it('accepts a long single string from a password manager', () => {
    // No spaces at all, so the word rule cannot be what lets it through.
    expect(checkPassphrase('kX7pQ2mVr9LzTn4wBsHd6yFj').ok).toBe(true);
  });

  it('imposes no character-class rule — that is the whole point', () => {
    expect(checkPassphrase('all lower case words here').ok).toBe(true);
  });
});

describe('checkPassphrase — what it refuses', () => {
  it('refuses anything short, and says how short', () => {
    const result = checkPassphrase('short pass');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain(String(PASSPHRASE_MIN_LENGTH));
    expect(result.problems[0]).toContain('10');
  });

  it('refuses a long-enough but wordless string under the single-string floor', () => {
    // 16-23 characters and fewer than four words: long enough to pass the
    // length floor, not long enough to stand alone.
    expect(checkPassphrase('mediumlengththing').ok).toBe(false);
  });

  it('refuses one word repeated to make up the count', () => {
    const result = checkPassphrase('north north north north');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('different words');
  });

  it('refuses the famous example passphrase', () => {
    expect(checkPassphrase('correct horse battery staple').ok).toBe(false);
  });

  it('refuses keyboard walks that are long enough to pass on length', () => {
    expect(checkPassphrase('qwertyuiopasdfghjkl').ok).toBe(false);
  });

  it('refuses a repeated unit however long it is', () => {
    expect(checkPassphrase('abcabcabcabcabcabcabc').ok).toBe(false);
  });

  it('refuses one built from the email address or the name', () => {
    expect(checkPassphrase('ada lovelace writes here', { email: 'lovelace@example.com' }).ok).toBe(
      false,
    );
    expect(checkPassphrase('grace hopper knows this', { name: 'Grace Hopper' }).ok).toBe(false);
  });

  it('refuses one built from the name of the application', () => {
    expect(checkPassphrase('aeolus is my editor here').ok).toBe(false);
  });

  it('refuses leading and trailing whitespace rather than trimming it', () => {
    // Trimming would mean the stored credential is not what was typed.
    const result = checkPassphrase(` ${GOOD} `);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('spaces');
  });

  it('refuses an absurdly long one in a single problem, without doing the rest of the work', () => {
    const result = checkPassphrase('x'.repeat(PASSPHRASE_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
  });

  it('reports every reason at once, so the UI can show them together', () => {
    // Long enough to clear the length floor, and then wrong in two ways: a
    // known phrase and a repeated unit. The screen lists both.
    expect(checkPassphrase('aaaaaaaaaaaaaaaa').problems.length).toBeGreaterThan(1);
  });
});

describe('PASSPHRASE_RULE', () => {
  it('states the numbers the checks actually enforce', () => {
    expect(PASSPHRASE_RULE).toContain('16');
    expect(PASSPHRASE_RULE).toContain('24');
  });
});

describe('generatePassphrase', () => {
  it('draws the asked-for number of words from the wordlist', () => {
    const words = generatePassphrase(6).split(' ');
    expect(words).toHaveLength(6);
    for (const w of words) expect(WORDLIST).toContain(w);
  });

  it('passes its own policy', () => {
    for (let i = 0; i < 25; i += 1) {
      const generated = generatePassphrase();
      expect(checkPassphrase(generated), generated).toEqual({ ok: true, problems: [] });
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generatePassphrase()));
    expect(seen.size).toBe(20);
  });

  it('ships the full EFF short list', () => {
    expect(WORDLIST).toHaveLength(1296);
    expect(new Set(WORDLIST).size).toBe(1296);
  });
});

describe('hashPassphrase / verifyPassphrase', () => {
  it('round-trips', async () => {
    const stored = await hashPassphrase(GOOD);
    expect(await verifyPassphrase(GOOD, stored)).toBe(true);
    expect(await verifyPassphrase('something else entirely', stored)).toBe(false);
  });

  it('salts each hash, so two identical passphrases do not collide on disk', async () => {
    const a = await hashPassphrase(GOOD);
    const b = await hashPassphrase(GOOD);
    expect(a).not.toBe(b);
    expect(await verifyPassphrase(GOOD, b)).toBe(true);
  });

  it('carries its parameters in the record', async () => {
    const [scheme, n, r, p, salt, hash] = (await hashPassphrase(GOOD)).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(SCRYPT_N);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
    expect(salt.length).toBeGreaterThan(0);
    expect(hash.length).toBeGreaterThan(0);
  });

  it('compares unicode by normalised form, so the same typing always works', async () => {
    // U+00E9 vs e + U+0301: the same passphrase from two keyboards.
    const stored = await hashPassphrase('café wander plaza tundra');
    expect(await verifyPassphrase('café wander plaza tundra', stored)).toBe(true);
  });

  it('returns false rather than throwing on a malformed record', async () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5', 'scrypt$x$8$1$aa$bb']) {
      expect(await verifyPassphrase(GOOD, bad)).toBe(false);
    }
    expect(await verifyPassphrase(GOOD, null)).toBe(false);
  });

  it('refuses a record whose parameters would allocate the heap', async () => {
    // A poisoned row must not become a memory exhaustion, and it must not be
    // distinguishable from a wrong passphrase.
    const stored = await hashPassphrase(GOOD);
    const [, , r, p, salt, hash] = stored.split('$');
    expect(await verifyPassphrase(GOOD, ['scrypt', 4_194_304, r, p, salt, hash].join('$'))).toBe(
      false,
    );
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current parameters', async () => {
    expect(needsRehash(await hashPassphrase(GOOD))).toBe(false);
  });

  it('is true for a weaker one, so verifying upgrades it in place', async () => {
    const [, , r, p, salt, hash] = (await hashPassphrase(GOOD)).split('$');
    expect(needsRehash(['scrypt', 16_384, r, p, salt, hash].join('$'))).toBe(true);
  });

  it('is true for anything it cannot read', () => {
    expect(needsRehash(null)).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});
