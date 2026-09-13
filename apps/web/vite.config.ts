import { createRequire } from 'node:module';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The vendored preset is CommonJS; read it here, at build time, so the editor
// theme can take the brand hexes from the same file Tailwind does instead of
// carrying a hand-copied list.
const preset = createRequire(import.meta.url)('./tailwind.preset.cjs') as {
  theme: { extend: { colors: { brand: Record<string, string> } } };
};

const apiTarget = process.env.AEOLUS_API_URL ?? 'http://localhost:4000';
const wsTarget = process.env.AEOLUS_WS_URL ?? 'ws://localhost:4001';
const host = process.env.HOST ?? 'localhost';
const port = Number(process.env.PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  // Version-footer stamp (minor-app standard 2026-07-02): CI passes
  // GIT_SHA (12-hex short commit) as a build-arg/env; local builds
  // show 'dev'. Rendered by src/components/VersionFooter.tsx.
  define: {
    __GIT_SHA__: JSON.stringify(process.env.GIT_SHA ?? 'dev'),
    __BRAND_PALETTE__: JSON.stringify(preset.theme.extend.colors.brand),
  },
  server: {
    host,
    port,
    strictPort: true,
    proxy: {
      // /api/* mirrors the production shape — api owns /api/*
      // routes server-side, so no rewrite. (Older config stripped
      // /api; dropped to keep dev/prod symmetric.)
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
      '/ws': {
        target: wsTarget,
        changeOrigin: false,
        ws: true,
        rewrite: (p) => p.replace(/^\/ws/, ''),
      },
    },
  },
  preview: {
    host,
    port,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 'hidden' still produces sourcemaps next to the bundle (so an
    // error tracker like Sentry can be uploaded a copy), but
    // doesn't emit `//# sourceMappingURL=` in the bundle so the
    // public URL doesn't expose your variable names + server-side
    // string literals to anyone who inspects the network tab.
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // Pull large third-party deps into their own chunks so a
        // change to app code doesn't bust the cached vendor chunk
        // and so users on /login don't pay for the editor stack.
        // Keys become the chunk name; the predicate runs per
        // module.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('codemirror') || id.includes('@codemirror') || id.includes('@lezer'))
            return 'codemirror';
          if (
            id.includes('y-codemirror.next') ||
            id.includes('y-websocket') ||
            id.includes('yjs') ||
            id.includes('y-protocols')
          )
            return 'yjs';
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          return undefined;
        },
      },
    },
  },
});
