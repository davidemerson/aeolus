// Appearance state — auto / light / dark.
//
// The client half of the appearance control, and
// this is its React-tier shape: the control is a <button>, not an <a href> to a
// server route, because a SPA does not render without JS and there is nothing
// for that fallback to degrade to. The server stamps `data-theme` into the shell
// (apps/api/src/appearance.ts), so the first paint is already correct and this
// module never races it.
//
// One thing a plain class toggle does not give us: the RESOLVED polarity
// as a value. Its CodeMirror editor has to be told which polarity to use — the
// `dark` boolean CodeMirror keeps for its own internals is not a colour and
// cannot come from a var() — so `useAppTheme()` publishes `isDark` and the
// editor follows it. See lib/editor-theme.ts.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'auto' | 'light' | 'dark';

export const THEMES: readonly Theme[] = ['auto', 'light', 'dark'] as const;
export const THEME_COOKIE = 'aeolus_theme';

export const THEME_LABEL: Record<Theme, string> = {
  auto: 'Appearance: auto',
  light: 'Appearance: light',
  dark: 'Appearance: dark',
};

/** What the document is showing right now. An ABSENT attribute means auto. */
export function domTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : 'auto';
}

/**
 * The cookie, read client-side. Needed because the attribute alone cannot seed
 * this: an ABSENT attribute is ambiguous — it means either "the user chose auto"
 * or "nothing stamped this shell". Same DOM, different intent.
 *
 * In production the Fastify server stamps, so the attribute is authoritative.
 * The Vite dev server serves index.html untouched, though, and so would any
 * future path that bypasses sendShell — and there an explicit choice would
 * silently stop surviving a reload. Reading the cookie makes the client correct
 * on its own rather than dependent on the server having done its half.
 */
export function cookieTheme(): Theme {
  const m = /(?:^|;\s*)aeolus_theme=(auto|light|dark)(?:;|$)/.exec(document.cookie);
  return (m?.[1] as Theme) ?? 'auto';
}

/**
 * Seed order: the stamped attribute wins — it is what the first paint already
 * used, so agreeing with it is what avoids a flash — then the cookie, then auto.
 */
function initialTheme(fallback?: Theme): Theme {
  const stamped = document.documentElement.getAttribute('data-theme');
  if (stamped === 'light' || stamped === 'dark') return stamped;
  const fromCookie = cookieTheme();
  if (fromCookie !== 'auto') return fromCookie;
  return fallback ?? 'auto';
}

/** What `auto` currently resolves to. */
function osPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolvedDark(theme: Theme): boolean {
  return theme === 'auto' ? osPrefersDark() : theme === 'dark';
}

/**
 * Not HttpOnly: the server reads the same cookie to stamp the shell, and this
 * writes it so the choice survives a reload. SameSite=Lax — aeolus and the
 * embedding page share a site, so it stays first-party in the iframe.
 * Secure only over https, or the dev server on plain http silently drops it and
 * the toggle appears not to persist with no error anywhere.
 */
function writeCookie(theme: Theme): void {
  document.cookie =
    `${THEME_COOKIE}=${theme};path=/;max-age=31536000;samesite=lax` +
    (location.protocol === 'https:' ? ';secure' : '');
}

export interface AppTheme {
  /** The chosen state: what the control shows. */
  theme: Theme;
  /** What it resolves to right now — follows the OS while `theme` is auto. */
  isDark: boolean;
  setTheme: (t: Theme) => void;
  cycle: () => void;
}

export function useAppTheme(initial?: Theme): AppTheme {
  // The stamped attribute first, then the cookie — see initialTheme(). Note
  // that `domTheme() || initial` would NEVER reach `initial`: domTheme() returns
  // the truthy 'auto' when the attribute is absent, so that fallback was dead
  // code and the cookie was never read client-side at all.
  const [theme, setThemeState] = useState<Theme>(() => initialTheme(initial));
  const [isDark, setIsDark] = useState<boolean>(() => resolvedDark(initialTheme(initial)));

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    setIsDark(resolvedDark(theme));
  }, [theme]);

  // The OS flipping mid-session. CSS follows it on its own via the media query;
  // the editor's `dark` flag does not, so this is not cosmetic.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setIsDark(resolvedDark(domTheme()));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    writeCookie(t);
  }, []);

  const cycle = useCallback(() => {
    // From `theme`, not domTheme(): they agree once the effect above has run,
    // but domTheme() cannot tell "chose auto" from "unstamped shell", and
    // cycling from the wrong one skips a state.
    setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!);
  }, [setTheme, theme]);

  return { theme, isDark, setTheme, cycle };
}

// ---- sharing one instance ---------------------------------------------------
//
// A context rather than calling useAppTheme() in each consumer. Two independent
// hook instances would each hold their own useState, so clicking the toggle in
// the header would flip the attribute but leave the editor's copy stale — the
// CodeMirror polarity would not follow until something else re-rendered it.
// One provider, one source of truth.

const AppThemeContext = createContext<AppTheme | null>(null);

export function AppThemeProvider({ children, initial }: { children: ReactNode; initial?: Theme }) {
  const value = useAppTheme(initial);
  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

/**
 * Falls back to a live read rather than throwing when used outside the
 * provider: several route components are rendered directly in tests, and a
 * missing provider should not be the thing that fails them.
 */
export function useAppThemeContext(): AppTheme {
  const ctx = useContext(AppThemeContext);
  if (ctx) return ctx;
  const theme = typeof document === 'undefined' ? 'auto' : domTheme();
  return {
    theme,
    isDark: typeof window === 'undefined' ? false : resolvedDark(theme),
    setTheme: () => {},
    cycle: () => {},
  };
}
