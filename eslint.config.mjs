import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

// No `{ts,tsx}` brace globs anywhere in this file: the root pins
// brace-expansion >= 5, whose API the minimatch bundled with ESLint's
// config-array does not speak, and a braced pattern makes ESLint abort with
// "expand is not a function". Spell each extension out.
const reactFiles = [
  'apps/web/**/*.ts',
  'apps/web/**/*.tsx',
  'packages/shared/**/*.ts',
  'packages/shared/**/*.tsx',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.cjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // The React surfaces: the SPA and the shared UI primitives.
  {
    ...jsxA11y.flatConfigs.recommended,
    files: reactFiles,
  },
  {
    files: reactFiles,
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // The two hook rules every React codebase runs. The plugin's v7
      // `recommended` preset also bundles the React Compiler diagnostics
      // (set-state-in-effect, purity, ...), which flag the session, theme
      // and route-guard sync effects this app is built on; adopting those
      // is a refactor of its own, not a lint switch.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Every autoFocus in this app is on a control that mounts in response
      // to the person's own action — an inline rename field, a reply box,
      // the command palette. Moving focus to the control they just asked
      // for is the accessible behaviour; the rule targets page-load focus.
      'jsx-a11y/no-autofocus': 'off',
    },
  },
);
