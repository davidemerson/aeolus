import { createRequire } from 'node:module';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const preset = createRequire(import.meta.url)('./tailwind.preset.cjs') as {
  theme: { extend: { colors: { brand: Record<string, string> } } };
};

export default defineConfig({
  plugins: [react()],
  // Mirror the vite.config.ts define so components that render the
  // version footer can be mounted under vitest.
  define: {
    __GIT_SHA__: JSON.stringify('dev'),
    __BRAND_PALETTE__: JSON.stringify(preset.theme.extend.colors.brand),
  },
  test: {
    // .tsx so the Link / route component tests under happy-dom
    // (browser-shaped environment) live next to the components
    // they cover.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'happy-dom',
  },
});
