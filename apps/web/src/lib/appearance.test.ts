// Seeding the appearance state, which has one subtlety worth pinning: an ABSENT
// data-theme attribute is ambiguous. It means either "the user chose auto" or
// "nothing stamped this shell", and those are the same DOM with different
// intents. The original code read `domTheme() || initial || 'auto'`, where
// domTheme() returns the TRUTHY 'auto' when the attribute is absent — so the
// fallbacks were dead code and the cookie was never consulted client-side.
//
// In production the server stamps, so it never showed. The Vite dev server does
// not, which is where it surfaced: an explicit choice stopped surviving a reload.
import { afterEach, describe, expect, it } from 'vitest';

import { cookieTheme, domTheme, resolvedDark } from './appearance.js';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  // jsdom keeps cookies for the document; expire ours between cases.
  document.cookie = 'aeolus_theme=; Max-Age=0; path=/';
});

describe('domTheme', () => {
  it('reads an explicit choice', () => {
    for (const t of ['light', 'dark'] as const) {
      document.documentElement.setAttribute('data-theme', t);
      expect(domTheme()).toBe(t);
    }
  });

  it('reports auto for an absent attribute — and for a junk one', () => {
    expect(domTheme()).toBe('auto');
    document.documentElement.setAttribute('data-theme', 'purple');
    expect(domTheme()).toBe('auto');
    // A literal "auto" should never be written, but reading one must not break.
    document.documentElement.setAttribute('data-theme', 'auto');
    expect(domTheme()).toBe('auto');
  });
});

describe('cookieTheme', () => {
  it('reads the cookie the server also reads', () => {
    document.cookie = 'aeolus_theme=dark; path=/';
    expect(cookieTheme()).toBe('dark');
  });

  it('finds it among other cookies', () => {
    document.cookie = 'other=1; path=/';
    document.cookie = 'aeolus_theme=light; path=/';
    expect(cookieTheme()).toBe('light');
  });

  it('is auto when unset, and never echoes a junk value', () => {
    expect(cookieTheme()).toBe('auto');
    document.cookie = 'aeolus_theme=purple; path=/';
    expect(cookieTheme()).toBe('auto');
  });

  it('does not mistake a similarly-named cookie for ours', () => {
    document.cookie = 'not_aeolus_theme=dark; path=/';
    expect(cookieTheme()).toBe('auto');
  });
});

describe('resolvedDark', () => {
  it('an explicit choice ignores the OS', () => {
    expect(resolvedDark('dark')).toBe(true);
    expect(resolvedDark('light')).toBe(false);
  });

  it('auto asks the OS', () => {
    // jsdom's matchMedia reports no match, so auto is light here. The point of
    // the assertion is that auto DELEGATES rather than hardcoding a polarity.
    expect(resolvedDark('auto')).toBe(false);
  });
});
