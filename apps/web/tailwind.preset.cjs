/**
 * The Aeolus Tailwind preset.
 *
 * Pairs with the @font-face blocks in src/styles/globals.css, the font files
 * in public/fonts/, and src/styles/tokens.css imported ahead of the @tailwind
 * directives — the semantic color names below resolve to the custom properties
 * that file defines, which is how the app flips theme without touching a
 * single utility class.
 *
 * TWO KINDS OF COLOR, and the difference matters:
 *
 *   ink-* / brand-*   FIXED literal scales. They do not flip. Use them when
 *                     you mean a specific hue regardless of theme.
 *   everything else   var()-backed semantic roles. They flip. Use these for
 *                     surfaces, text, borders and status — always.
 *
 * In particular there is a `surface` color, so `bg-white` is never correct
 * here: it is Tailwind's literal #fff and cannot follow a theme.
 */
module.exports = {
  // The `dark:` variant is an escape hatch, not the mechanism — the semantic
  // colors already flip on their own. It mirrors tokens.css's cascade exactly
  // so the two can never disagree about what "dark" means.
  darkMode: [
    'variant',
    [
      '&:is(:root[data-theme="dark"] *)',
      '@media (prefers-color-scheme: dark) { &:is(:root:not([data-theme="light"]) *) }',
    ],
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Jost',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        // ---- fixed literal scales (do NOT flip) ----
        ink: {
          '50': '#f5f5f4',
          '100': '#e7e5e4',
          '200': '#d6d3d1',
          '300': '#c0bcb8',
          '400': '#a8a29e',
          '500': '#78716c',
          '600': '#6d6661',
          '700': '#44403c',
          '800': '#292524',
          '900': '#1c1917',
          '950': '#0c0a09',
        },
        // The Aeolus teal. Every step is checked against the surfaces it is
        // used on by scripts/check-contrast.mjs; the ones the editor theme
        // reaches for are noted in src/lib/editor-theme.ts.
        brand: {
          '50': '#effbfa',
          '100': '#d3f4f2',
          '200': '#a8e5e3',
          '300': '#6fd3d1',
          '400': '#31b8b8',
          '500': '#17a2a4',
          '600': '#0f8489',
          '700': '#0c6d73',
          '800': '#0e575e',
          '900': '#11454b',
          '950': '#082b30',
          'DEFAULT': '#17a2a4',
        },

        // ---- themed semantic roles (flip with data-theme) ----
        success: {
          fg: 'var(--success-fg)',
          'fg-strong': 'var(--success-fg-strong)',
          bg: 'var(--success-bg)',
          'bg-soft': 'var(--success-bg-soft)',
          'bg-alt': 'var(--success-bg-alt)',
          border: 'var(--success-border)',
          edge: 'var(--success-edge)',
        },
        danger: {
          fg: 'var(--danger-fg)',
          'fg-strong': 'var(--danger-fg-strong)',
          bg: 'var(--danger-bg)',
          'bg-strong': 'var(--danger-bg-strong)',
          'bg-alt': 'var(--danger-bg-alt)',
          border: 'var(--danger-border)',
          edge: 'var(--danger-edge)',
        },
        warning: {
          fg: 'var(--warning-fg)',
          'fg-strong': 'var(--warning-fg-strong)',
          bg: 'var(--warning-bg)',
          'bg-alt': 'var(--warning-bg-alt)',
          border: 'var(--warning-border)',
          edge: 'var(--warning-edge)',
        },
        notice: {
          fg: 'var(--notice-fg)',
          'fg-strong': 'var(--notice-fg-strong)',
          bg: 'var(--notice-bg)',
          'bg-alt': 'var(--notice-bg-alt)',
          border: 'var(--notice-border)',
          edge: 'var(--notice-edge)',
        },
        info: {
          fg: 'var(--info-fg)',
          'fg-strong': 'var(--info-fg-strong)',
          bg: 'var(--info-bg)',
          'bg-alt': 'var(--info-bg-alt)',
          border: 'var(--info-border)',
          edge: 'var(--info-edge)',
        },
        neutral: {
          fg: 'var(--neutral-fg)',
          'fg-strong': 'var(--neutral-fg-strong)',
          bg: 'var(--neutral-bg)',
          'bg-alt': 'var(--neutral-bg-alt)',
          border: 'var(--neutral-border)',
          edge: 'var(--neutral-edge)',
        },
        accent: {
          'DEFAULT': 'var(--accent)',
          fg: 'var(--accent-fg)',
          'fg-strong': 'var(--accent-fg-strong)',
          bg: 'var(--accent-bg)',
          'bg-alt': 'var(--accent-bg-alt)',
          border: 'var(--accent-border)',
          edge: 'var(--accent-edge)',
        },
        page: 'var(--bg)',
        surface: 'var(--card)',
        'surface-2': 'var(--raised)',
        paper: 'var(--fill-paper)',
        'fill-hover': 'var(--fill-hover)',
        'fill-warm': 'var(--fill-warm)',
        'fill-accent': 'var(--fill-accent)',
        hairline: 'var(--line)',
        'hairline-strong': 'var(--line2)',
        'paper-edge': 'var(--paper-edge)',
        body: 'var(--ink)',
        'body-2': 'var(--ink2)',
        muted: 'var(--muted)',
        placeholder: 'var(--placeholder)',
        'accent-strong': 'var(--accent-strong)',
        'accent-text': 'var(--accent-text)',
        // Scrim behind a dialog or palette. tokens.css defines --backdrop in
        // every block; the preset had no name for it, so the command palette
        // shipped with no scrim at all.
        backdrop: 'var(--backdrop)',
        focus: 'var(--focus)',
        destructive: 'var(--destructive)',
        'btn-primary': 'var(--btn-primary-bg)',
        'btn-primary-fg': 'var(--btn-primary-fg)',
        'btn-primary-hover': 'var(--btn-primary-hover-bg)',
        'btn-primary-active': 'var(--btn-primary-active-bg)',
        'btn-danger': 'var(--btn-danger-bg)',
        'btn-danger-fg': 'var(--btn-danger-fg)',
        'btn-danger-hover': 'var(--btn-danger-hover-bg)',
        'btn-danger-border': 'var(--btn-danger-border)',
        inverse: 'var(--inverse-bg)',
        'inverse-fg': 'var(--inverse-fg)',
        'inverse-border': 'var(--inverse-border)',
        'inverse-hover': 'var(--inverse-hover-bg)',
      },
      // The soft radius scale: badges 6, small buttons 7, inputs and buttons
      // 8, avatars 9, message boxes 10, cards and dialogs 14. Keeping the
      // whole scale in one place is what stops a component reaching for a
      // stop that does not exist and silently getting the default.
      borderRadius: {
        DEFAULT: '8px',
        badge: '6px',
        'btn-sm': '7px',
        avatar: '9px',
        box: '10px',
        card: '14px',
      },
      letterSpacing: { wider: '0.06em', widest: '0.12em' },
      // Shadows are var()-backed because dark cannot use light's shadows —
      // see tokens.json § elevation. On dark, depth comes from surface-2 plus
      // a hairline-strong border, and the shadow is only ambient darkening.
      boxShadow: {
        card: 'var(--shadow-card)',
        'soft-lift': 'var(--shadow-soft-lift)',
        'soft-hover': 'var(--shadow-soft-hover)',
        menu: 'var(--shadow-menu)',
        dialog: 'var(--shadow-dialog)',
        'cell-reveal': 'var(--shadow-cell-reveal)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
      },
    },
  },
};
