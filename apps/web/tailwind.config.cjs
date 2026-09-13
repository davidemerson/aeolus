/** @type {import('tailwindcss').Config} */
//
// The whole theme lives in tailwind.preset.cjs: the palette, the fonts, the
// radii and the semantic colour roles. Change it there, not here.
//
// Two kinds of colour, and the difference matters. `ink-*` and `brand-*` are
// fixed literal scales that do not flip with the theme. Everything else is a
// var()-backed role — `surface`, `body`, `muted`, `hairline` — which does.
// Use a role for anything that has to work in both polarities, which is
// nearly everything. `bg-white` is never right: it is a literal #fff.
module.exports = {
  presets: [require('./tailwind.preset.cjs')],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/shared/src/ui/**/*.{ts,tsx}'],
  plugins: [],
};
