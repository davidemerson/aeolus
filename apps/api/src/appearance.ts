// Server-side half of the appearance control (light / dark / auto).
//
// Two things are injected into the SPA shell on its way out: the theme
// (below) and the runtime configuration (stampConfig at the end of this file).
// Both go through the same one-tag rewrite, and both have to happen on every
// path that emits the shell.
//
// On the theme:
//
//  1. The shell is stamped here rather than by an inline pre-paint script.
//     Stamping is strictly better (no script to race the first paint, and
//     nothing to hash into the CSP — which now exists, see server.ts) and it
//     Read the cookie, inject data-theme into the HTML we send.
//
//  2. The control is a <button>, not an <a href> with a server fallback. The
//     vanilla apps use a link so the switch survives JS being off; a React SPA
//     does not render at all without JS, so there is nothing for that fallback
//     to degrade to. The client writes the cookie itself (it is not HttpOnly),
//     so no endpoint is needed to persist it.
//
// Aeolus stamps the shell through TWO paths — fastify-static's index and the
// SPA-fallback notFoundHandler — and both have to go through it, or a deep
// link like /docs/:id renders unstamped while / renders correctly.

export type Theme = 'auto' | 'light' | 'dark';

export const THEME_COOKIE = 'aeolus_theme';

/** Anything unrecognised is `auto` — the value reaches an HTML attribute. */
export function readTheme(cookieHeader: string | undefined): Theme {
  const m = /(?:^|;\s*)aeolus_theme=(auto|light|dark)(?:;|$)/.exec(cookieHeader ?? '');
  return (m?.[1] as Theme) ?? 'auto';
}

/**
 * Inject `data-theme` into the SPA shell. Absent for `auto` — the CSS keys
 * off the attribute not existing, so an explicit "auto" must not be written.
 *
 * Deliberately narrow: it rewrites the one `<html ...>` open tag and nothing
 * else. Vite emits `<html lang="en">`; if that ever changes shape this
 * returns the HTML untouched rather than guessing, and the page falls back to
 * following the OS — which is the correct default, not a broken state.
 */
export function stampTheme(html: string, theme: Theme): string {
  if (theme === 'auto') return html;
  return html.replace(/<html(\s[^>]*)?>/i, (tag, attrs: string | undefined) => {
    if (/\sdata-theme=/i.test(tag)) return tag;
    return `<html${attrs ?? ''} data-theme="${theme}">`;
  });
}

/**
 * Runtime configuration for the SPA, injected into the shell as a JSON blob
 * the client reads before it connects to anything.
 *
 * Why not a build arg: the WebSocket URL used to be frozen into the bundle by
 * `VITE_WS_URL` at `docker build` time, so the published image only worked for
 * the hostname it was built for and every self-hoster had to rebuild it. Now
 * one image runs anywhere and the operator sets an environment variable.
 */
export interface RuntimeConfig {
  /**
   * Where the editor opens its WebSocket. Empty means same origin at `/ws`,
   * which is what the bundled compose stack serves through its reverse proxy.
   */
  wsUrl?: string;
}

/** The element id the client looks for. Keep in step with apps/web. */
export const RUNTIME_CONFIG_ID = 'aeolus-config';

export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const wsUrl = env.AEOLUS_WS_URL?.trim();
  return wsUrl ? { wsUrl } : {};
}

/**
 * Inject the config as `<script type="application/json">` immediately after
 * `<head>`. Not an executable script and not an attribute: JSON in a
 * non-executing script element cannot run, needs no CSP hash, and survives any
 * value an operator puts in the environment.
 *
 * `</` is escaped because the one string that could end the element early is a
 * closing tag inside the JSON.
 */
export function stampConfig(html: string, config: RuntimeConfig): string {
  if (Object.keys(config).length === 0) return html;
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const tag = `<script type="application/json" id="${RUNTIME_CONFIG_ID}">${json}</script>`;
  if (html.includes(`id="${RUNTIME_CONFIG_ID}"`)) return html;
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${tag}`);
}
