/**
 * Configuration the server stamps into the page, read once at module load.
 *
 * The alternative is a Vite build arg, which freezes the value into the bundle
 * — so the published image would only work for the hostname it was built for.
 * The api injects a `<script type="application/json">` into the shell instead
 * (apps/api/src/appearance.ts), and one image runs anywhere.
 */
export interface RuntimeConfig {
  wsUrl?: string;
}

const RUNTIME_CONFIG_ID = 'aeolus-config';

function read(): RuntimeConfig {
  if (typeof document === 'undefined') return {};
  const el = document.getElementById(RUNTIME_CONFIG_ID);
  if (!el?.textContent) return {};
  try {
    const parsed: unknown = JSON.parse(el.textContent);
    return parsed && typeof parsed === 'object' ? (parsed as RuntimeConfig) : {};
  } catch {
    // A malformed blob means the defaults below apply, which is a working
    // same-origin setup — better than a blank page.
    return {};
  }
}

export const runtimeConfig: RuntimeConfig = read();

/**
 * Where the editor's WebSocket goes.
 *
 * Default: this origin with a `/ws` prefix. That is what the bundled compose
 * stack serves (one reverse proxy in front of both processes) and what the
 * Vite dev server proxies, so most installs never set anything.
 */
export function wsBaseUrl(): string {
  const configured = runtimeConfig.wsUrl?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const origin =
    typeof window !== 'undefined' && window.location.origin
      ? window.location.origin.replace(/^http/, 'ws')
      : 'ws://127.0.0.1:5173';
  return `${origin}/ws`;
}
