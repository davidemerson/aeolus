import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .tsx for the UI primitive tests, which declare the happy-dom
    // environment per file (`// @vitest-environment happy-dom`).
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
