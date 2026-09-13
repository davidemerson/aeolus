/// <reference types="vite/client" />

// Build-time constant injected via `define` in vite.config.ts (and
// vitest.config.ts for tests): the 12-hex short git sha, or 'dev'
// when GIT_SHA is unset. Rendered by components/VersionFooter.tsx.
declare const __GIT_SHA__: string;

// The preset's fixed `brand` scale (tailwind.preset.cjs → theme.extend.colors
// .brand), injected via `define` so lib/editor-theme.ts reads the same hexes
// Tailwind compiles against. Keys are the scale stops ('300', '500', ...).
declare const __BRAND_PALETTE__: Record<string, string>;
