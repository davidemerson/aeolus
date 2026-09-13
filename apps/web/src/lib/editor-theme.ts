import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// Solarized palette (Ethan Schoonover, exact hex values from
// https://ethanschoonover.com/solarized/). Names kept verbatim so
// callers reading this file alongside the canonical reference can
// follow the mapping without translation. The accent colours
// (yellow…green) are shared between the Light and Dark variants;
// only the base tones swap roles per the Solarized spec.
const base03 = '#002b36'; // background (dark)
const base02 = '#073642'; // background highlight (dark)
const base01 = '#586e75'; // comments / secondary content
const base00 = '#657b83'; // body text (light)
const base0 = '#839496'; // body text (dark)
const base1 = '#93a1a1'; // emphasised content
const base2 = '#eee8d5'; // background highlight (light)
const base3 = '#fdf6e3'; // background (light)
// Solarized's `yellow`, `orange` and `cyan` are not referenced. The first two
// were the warm slots the brand hues now occupy; `cyan` is close enough to the
// brand teal that using both would stop two token classes being tellable
// apart, so strings take Solarized green in both themes instead.
const red = '#dc322f';
const magenta = '#d33682';
const violet = '#6c71c4';
const blue = '#268bd2';
const green = '#859900';

// The Aeolus teal, read from the Tailwind preset at build time
// (`__BRAND_PALETTE__`, a Vite define — see vite.config.ts), so the editor and
// the rest of the UI cannot drift apart. Used where a brand presence reads
// stronger than another Solarized hue, and only at steps that clear WCAG AA
// against the background they land on — the ratios are in
// scripts/check-contrast.mjs, which fails the build if a step stops passing.
//
// Which steps work where: the pale end on the dark ground, the deep end on the
// light one. Nothing in the middle clears AA on either.
const brand200 = __BRAND_PALETTE__['200']; // pale teal  — 10.7:1 on base03
const brand300 = __BRAND_PALETTE__['300']; //            —  8.5:1 on base03
const brand400 = __BRAND_PALETTE__['400']; //            —  6.2:1 on base03
const brand500 = __BRAND_PALETTE__['500']; // the mark   —  4.8:1 on base03
const brand700 = __BRAND_PALETTE__['700']; //            —  5.6:1 on base3
const brand800 = __BRAND_PALETTE__['800']; //            —  7.7:1 on base3
const brand900 = __BRAND_PALETTE__['900']; // deepest    —  9.9:1 on base3

// The mono stack wins via specificity here even when CodeMirror's own
// descendants (cm-content, cm-line, cm-gutter) inherit conflicting rules.
// Setting it on '&' (the cm-editor root) + '.cm-scroller' covers every
// text-bearing node CodeMirror emits.
const monoStack = [
  '"JetBrains Mono"',
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  'monospace',
].join(', ');

interface ThemeRoles {
  bg: string; // editor background
  bgHighlight: string; // selection / active-line tint
  body: string; // primary text colour
  emphasis: string; // caret + cursor + bracket outline
  secondary: string; // gutters, comments, fold placeholders
  tooltipBg: string;
  isDark: boolean;
  // Active-line tint colour. A faint wash of the brand teal over the
  // background, so the cursor row is findable without competing with the
  // syntax colours.
  activeLineRgba: string;
}

// Token colour map. Solarized's stock palette deliberately spans the wheel so
// token classes stay distinguishable. Brand teal takes the structural roles —
// keywords, type names, headings, operators — and the Solarized hues that are
// nowhere near teal keep the rest. Different hex per theme, because only
// certain brand steps clear WCAG AA against each background.
//
// One thing to know before editing this: Solarized's own accent hues sit
// between 2.9:1 and 4.8:1 against their own backgrounds. That is Solarized,
// not an oversight — the palette was designed around a narrow luminance range
// on purpose. The brand steps chosen here all clear 4.5:1, and those are what
// scripts/check-contrast.mjs enforces.
interface AccentRoles {
  // \section, \begin, \emph — the visual anchor of LaTeX source.
  keyword: string;
  // Environment / type names (article, equation, theorem). Also
  // used for headings.
  typeName: string;
  // Document headings (= H1 / H2 in Typst, or \chapter etc).
  heading: string;
  // \cite, \ref, \label — names that point at definitions.
  definition: string;
  // String literals / regex / link URLs.
  string: string;
  // Numeric literals, booleans, atoms.
  number: string;
  // +, -, =, etc.
  operator: string;
  // Bare variable / property names (rare in LaTeX, common in
  // Typst).
  variable: string;
  // Named constants — \LaTeX, true, false, the standard library
  // namespace.
  constant: string;
  // Lexer flagged this token as invalid.
  invalid: string;
}

function buildEditorTheme(roles: ThemeRoles): Extension {
  return EditorView.theme(
    {
      '&': {
        color: roles.body,
        backgroundColor: roles.bg,
        height: '100%',
        fontFamily: monoStack,
        fontVariantLigatures: 'none',
      },
      '.cm-scroller': {
        fontFamily: monoStack,
      },
      '.cm-content': {
        caretColor: roles.emphasis,
        padding: '1rem',
        fontFamily: monoStack,
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: roles.emphasis,
      },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: roles.bgHighlight,
      },
      '&.cm-focused .cm-selectionBackground, .cm-line ::selection': {
        backgroundColor: roles.bgHighlight,
      },
      '.cm-gutters': {
        backgroundColor: roles.bg,
        color: roles.secondary,
        border: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        color: roles.secondary,
      },
      '.cm-activeLine': {
        backgroundColor: roles.activeLineRgba,
      },
      '.cm-activeLineGutter': {
        backgroundColor: roles.activeLineRgba,
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'transparent',
        color: roles.secondary,
        border: 'none',
      },
      '.cm-tooltip': {
        backgroundColor: roles.tooltipBg,
        border: `1px solid ${roles.secondary}`,
        color: roles.body,
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'transparent',
        outline: `1px solid ${roles.secondary}`,
      },
      // Remote collaborators' carets (y-codemirror.next). Its base theme
      // labels the caret in `serif` — the only serif in the app — and in
      // white, which is ~2:1 against the bright carets the dark palette needs
      // on base03. The app's mono face, and the label colour flips with the
      // ground (see lib/collab-colors.ts for the numbers).
      '.cm-ySelectionInfo': {
        fontFamily: monoStack,
        fontSize: '0.7em',
        color: roles.isDark ? roles.bg : '#ffffff',
        borderRadius: '2px',
        paddingLeft: '4px',
        paddingRight: '4px',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: roles.emphasis,
      },
    },
    { dark: roles.isDark },
  );
}

// Caret and active-line tint borrow from the brand palette so the "now
// editing" cue is unmistakable without overpowering the syntax colours. The
// light variant uses a deeper step so the wash stays visible on the cream bg.
const darkRoles: ThemeRoles = {
  bg: base03,
  bgHighlight: base02,
  body: base0,
  // brand-400 cursor on dark — 6.2:1 against base03, so the editing position
  // is unmissable.
  emphasis: brand400,
  secondary: base01,
  tooltipBg: base02,
  isDark: true,
  // brand-400 @ 8% alpha. A subtle teal wash on the active row.
  activeLineRgba: 'rgba(49, 184, 184, 0.08)',
};

const lightRoles: ThemeRoles = {
  bg: base3,
  bgHighlight: base2,
  body: base00,
  // brand-700 cursor on light — 5.6:1 against base3: clearly visible on the
  // cream bg without shouting.
  emphasis: brand700,
  secondary: base1,
  tooltipBg: base2,
  isDark: false,
  // brand-500 @ 10% alpha — a touch stronger than the dark wash so it carries
  // on the lighter bg.
  activeLineRgba: 'rgba(23, 162, 164, 0.10)',
};

// Per-theme accent maps. The four structural roles take brand steps; blue,
// green, magenta and violet keep the rest apart.
const darkAccents: AccentRoles = {
  keyword: brand300,
  typeName: brand400,
  heading: brand200,
  definition: blue,
  string: green,
  number: magenta,
  operator: brand500,
  variable: blue,
  constant: violet,
  invalid: red,
};

const lightAccents: AccentRoles = {
  keyword: brand800,
  typeName: brand900,
  heading: brand900,
  definition: blue,
  string: green,
  number: magenta,
  operator: brand700,
  variable: blue,
  constant: violet,
  invalid: red,
};

// Tag → colour mapping covers the stream-parser token kinds that
// `@codemirror/legacy-modes/mode/stex` emits (keyword, comment,
// string, bracket, atom, number) plus the broader Lezer tag set,
// so the same theme will look right when we add Typst (`lang-typst`)
// or any future Lezer-based grammar. Per-theme accents come in
// through `accents`; chrome roles (comments, body punctuation) are
// resolved off `roles`.
function buildHighlight(roles: ThemeRoles, accents: AccentRoles): HighlightStyle {
  return HighlightStyle.define([
    {
      tag: [t.keyword, t.controlKeyword, t.modifier, t.self, t.null],
      color: accents.keyword,
      fontWeight: '600',
    },
    {
      tag: [t.tagName, t.typeName, t.className, t.namespace],
      color: accents.typeName,
    },
    {
      tag: [t.definition(t.name), t.macroName, t.labelName],
      color: accents.definition,
      fontWeight: '600',
    },
    {
      tag: [t.string, t.special(t.string), t.regexp],
      color: accents.string,
    },
    {
      tag: [t.number, t.bool, t.atom, t.float],
      color: accents.number,
    },
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: roles.secondary,
      fontStyle: 'italic',
    },
    {
      tag: [t.operator, t.derefOperator, t.compareOperator, t.arithmeticOperator],
      color: accents.operator,
    },
    {
      tag: [t.brace, t.bracket, t.paren, t.punctuation, t.separator],
      color: roles.body,
    },
    {
      tag: [t.variableName, t.propertyName, t.attributeName],
      color: accents.variable,
    },
    {
      tag: [t.constant(t.name), t.standard(t.name)],
      color: accents.constant,
    },
    {
      tag: [t.heading],
      color: accents.heading,
      fontWeight: '700',
    },
    {
      tag: [t.link, t.url],
      color: accents.string,
      textDecoration: 'underline',
    },
    {
      tag: [t.invalid],
      color: accents.invalid,
    },
    {
      tag: [t.meta, t.processingInstruction, t.docString],
      color: roles.secondary,
    },
    {
      tag: [t.emphasis],
      fontStyle: 'italic',
    },
    {
      tag: [t.strong],
      fontWeight: '700',
    },
  ]);
}

export const solarizedDark: Extension = [
  buildEditorTheme(darkRoles),
  syntaxHighlighting(buildHighlight(darkRoles, darkAccents)),
];

export const solarizedLight: Extension = [
  buildEditorTheme(lightRoles),
  syntaxHighlighting(buildHighlight(lightRoles, lightAccents)),
];

// `auto` follows the APP's theme, and is the default as of 2026-08-12.
//
// Before that the editor was a permanently-DARK island inside a
// permanently-light shell, with its own preference and its own toggle. That
// was defensible when the app had no theme of its own; once it does, an
// unrelated third colour context is just one more thing for the reader to
// parse. The two Solarized variants stay as explicit overrides, because a dark
// editor beside a white PDF page is a real authoring preference and this change
// should not take it away — it should stop being the only option.
//
// NOTE the editor keeps Solarized rather than the app's own token palette.
// Solarized is a deliberate, externally-specified code palette whose hues are
// chosen to keep token classes apart; the app's neutrals are chosen to be
// quiet. They are different jobs, and a code surface is the one place worth
// spending a second palette on.
export type EditorThemeName = 'auto' | 'solarized-dark' | 'solarized-light';

export function isEditorThemeName(v: unknown): v is EditorThemeName {
  return v === 'auto' || v === 'solarized-dark' || v === 'solarized-light';
}

/** Which polarity the setting resolves to, given the app's current polarity. */
export function resolveEditorDark(name: EditorThemeName, appIsDark: boolean): boolean {
  return name === 'auto' ? appIsDark : name === 'solarized-dark';
}

export function getEditorTheme(name: EditorThemeName, appIsDark = false): Extension {
  return resolveEditorDark(name, appIsDark) ? solarizedDark : solarizedLight;
}

// Background colour matching the editor host's outer div in doc-editor.tsx —
// set on mount to avoid a flash before CodeMirror paints. Lives here so the SPA
// never has to know which Solarized hex is which.
export function editorHostBg(name: EditorThemeName, appIsDark = false): string {
  return resolveEditorDark(name, appIsDark) ? base03 : base3;
}

// ---- swapping the theme without remounting ---------------------------------
//
// The theme lives in a Compartment so it can be reconfigured in place. This
// replaced a full EditorView teardown, which for a COLLABORATIVE editor also
// meant destroying the Y.Doc and reconnecting the yjs WebSocket — a colour
// change was dropping and re-establishing the session. The old comment in
// useDocWsConnection.ts said CodeMirror "doesn't support hot-swapping a theme
// extension cleanly without losing the local view state"; a Compartment is
// exactly that mechanism, and the view state is untouched.
//
// This matters more now than it did: with the editor following the app theme,
// remount-on-change would mean the appearance toggle kicks you off the
// collaborative session.
export const editorThemeCompartment = new Compartment();

/** The compartment's initial contents, for the extensions array. */
export function editorThemeExtension(name: EditorThemeName, appIsDark: boolean): Extension {
  return editorThemeCompartment.of(getEditorTheme(name, appIsDark));
}

/** Swap polarity in place. No remount, no reconnect. */
export function setEditorTheme(view: EditorView, name: EditorThemeName, appIsDark: boolean): void {
  view.dispatch({
    effects: editorThemeCompartment.reconfigure(getEditorTheme(name, appIsDark)),
  });
}

// ---- the persisted preference ------------------------------------------------
//
// One key, one reader, one writer. The settings page and the editor route each
// carried a private copy of the reader (and the key string), which is how the
// two ends of a `storage`-event handshake drift apart. An open editor tab
// listens for this key and re-reads on change, so the settings page writing
// it is what makes a theme pick apply live.
export const EDITOR_THEME_KEY = 'aeolus.editor.theme';

export function readEditorTheme(): EditorThemeName {
  try {
    const v = localStorage.getItem(EDITOR_THEME_KEY);
    return isEditorThemeName(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Persist a pick; a browser without localStorage keeps it for the session only. */
export function writeEditorTheme(name: EditorThemeName): void {
  try {
    localStorage.setItem(EDITOR_THEME_KEY, name);
  } catch {
    /* ignore — the in-memory state still applies */
  }
}
