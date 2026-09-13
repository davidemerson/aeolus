// The editor-theme resolution, which is the piece that decides what
// "auto" means and is now load-bearing for two independent settings.
//
// Before 2026-08-12 the editor was permanently dark inside a permanently light
// shell, with its own preference. It now defaults to following the app, with
// the two Solarized variants kept as explicit overrides — so the truth table
// below is the whole behaviour change, and it is worth pinning.
import { describe, expect, it } from 'vitest';

import {
  EDITOR_THEME_KEY,
  editorHostBg,
  isEditorThemeName,
  readEditorTheme,
  resolveEditorDark,
  solarizedDark,
  solarizedLight,
  getEditorTheme,
  writeEditorTheme,
} from './editor-theme.js';

describe('isEditorThemeName', () => {
  it('accepts the three states and nothing else', () => {
    for (const v of ['auto', 'solarized-dark', 'solarized-light']) {
      expect(isEditorThemeName(v)).toBe(true);
    }
    // The pre-2026-08-12 reader defaulted anything-not-light to dark, so a junk
    // value silently meant "dark". Now junk means auto, via this guard.
    for (const v of ['', 'dark', 'light', 'solarized', null, undefined, 0]) {
      expect(isEditorThemeName(v)).toBe(false);
    }
  });
});

describe('resolveEditorDark', () => {
  it('auto follows the app in both directions', () => {
    expect(resolveEditorDark('auto', true)).toBe(true);
    expect(resolveEditorDark('auto', false)).toBe(false);
  });

  it('an explicit choice ignores the app — that is the point of pinning', () => {
    // A dark editor beside a light UI is a real authoring preference; this is
    // what keeps it available.
    expect(resolveEditorDark('solarized-dark', false)).toBe(true);
    expect(resolveEditorDark('solarized-light', true)).toBe(false);
    expect(resolveEditorDark('solarized-dark', true)).toBe(true);
    expect(resolveEditorDark('solarized-light', false)).toBe(false);
  });
});

describe('getEditorTheme', () => {
  it('returns the variant the polarity resolves to', () => {
    expect(getEditorTheme('auto', true)).toBe(solarizedDark);
    expect(getEditorTheme('auto', false)).toBe(solarizedLight);
    expect(getEditorTheme('solarized-light', true)).toBe(solarizedLight);
    expect(getEditorTheme('solarized-dark', false)).toBe(solarizedDark);
  });
});

describe('editorHostBg', () => {
  // The host div is painted before CodeMirror does, so a wrong value here is a
  // visible flash of the opposite theme on every editor mount.
  it('matches the resolved variant, Solarized base03 / base3', () => {
    expect(editorHostBg('auto', true)).toBe('#002b36');
    expect(editorHostBg('auto', false)).toBe('#fdf6e3');
    expect(editorHostBg('solarized-dark', false)).toBe('#002b36');
    expect(editorHostBg('solarized-light', true)).toBe('#fdf6e3');
  });
});

describe('readEditorTheme / writeEditorTheme', () => {
  it('round-trips a pick through localStorage under the shared key', () => {
    localStorage.removeItem(EDITOR_THEME_KEY);
    expect(readEditorTheme()).toBe('auto');
    writeEditorTheme('solarized-dark');
    expect(localStorage.getItem(EDITOR_THEME_KEY)).toBe('solarized-dark');
    expect(readEditorTheme()).toBe('solarized-dark');
    localStorage.removeItem(EDITOR_THEME_KEY);
  });

  it('treats a junk stored value as auto rather than dark', () => {
    localStorage.setItem(EDITOR_THEME_KEY, 'dark');
    expect(readEditorTheme()).toBe('auto');
    localStorage.removeItem(EDITOR_THEME_KEY);
  });
});
