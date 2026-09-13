// The appearance control: one button cycling auto -> light -> dark.
//
// The mark is an inline SVG rather than a Unicode glyph. Neither self-hosted
// face covers the geometric-shapes block — ◐ U+25D0, ●, ☀ and ☾ are in
// neither — so a glyph would fall to OS fallback and tofu on a font-poor
// host.
//
// Three parts, shown or hidden by state: the ring is always there, a filled half
// means `auto` ("half of each — whatever the OS says"), a solid fill means dark,
// and the bare ring means light.
import type { Theme } from '../lib/appearance.js';
import { THEME_LABEL } from '../lib/appearance.js';

function ThemeMark({ theme }: { theme: Theme }) {
  return (
    // shrink-0 is load-bearing: without it the header's flex row squeezes a
    // 13px square down to 8x13.
    <svg viewBox="0 0 16 16" aria-hidden className="h-[13px] w-[13px] shrink-0">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {theme === 'auto' ? <path d="M8 1.5a6.5 6.5 0 0 0 0 13z" fill="currentColor" /> : null}
      {theme === 'dark' ? <circle cx="8" cy="8" r="6.5" fill="currentColor" /> : null}
    </svg>
  );
}

export function AppearanceToggle({
  theme,
  onCycle,
  className = '',
}: {
  theme: Theme;
  onCycle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onCycle}
      aria-label={THEME_LABEL[theme]}
      title={THEME_LABEL[theme]}
      className={`inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-badge text-muted transition-colors hover:bg-hairline hover:text-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus print:hidden ${className}`}
    >
      <ThemeMark theme={theme} />
    </button>
  );
}
