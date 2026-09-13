// Collaborator identity for the editor's remote carets (#68).
//
// y-codemirror.next reads `awareness.state.user = { name, color, colorLight }`
// to label and colour each remote caret; when the field is absent every
// participant renders as the same cyan "Anonymous". Aeolus never set it, so a
// three-person session looked like one nameless person.
//
// Colour is derived deterministically from the user id, so a given person is
// the same colour to everyone in the room and across reloads, with no
// coordination or storage. Eight hues, one variant per editor ground:
//
//   - LIGHT sits on Solarized base3 (#fdf6e3); DARK on base03 (#002b36).
//   - Adjacent-pair CIE76 ΔE: light ≥ 22.9, dark ≥ 22.8 (every pair, not just
//     neighbours). Caret contrast vs ground: light 3.95–5.05, dark 6.64–8.55.
//     Label text on the caret: white on light (4.26–5.44), base03 on dark
//     (6.64–8.55) — white on the bright dark-ground carets would be ~2:1,
//     which is why the label colour flips with the theme (editor-theme.ts).
//   - Those numbers are asserted, not just recorded: collab-colors.test.ts
//     recomputes them, so a palette edit that breaks distinguishability
//     fails the unit suite. (Same discipline as any other palette
//     bands; ~8% of male users have some colour-vision deficiency, and a
//     palette picked by eye is how you fail them.)
//
// `colorLight` is the selection tint. y-codemirror's default is the caret
// colour at 20% alpha, which is nearly invisible on base03; the dark variant
// uses 35%, the light 25%.

export interface CollabUser {
  name: string;
  color: string;
  colorLight: string;
}

export const LIGHT_PALETTE: readonly string[] = [
  '#b3541e', // rust
  '#a3711a', // ochre
  '#5f7d1f', // olive
  '#1f8a6a', // teal
  '#1f7fa6', // cerulean
  '#4f62c2', // indigo
  '#8a4fb5', // violet
  '#b5427a', // magenta
];

export const DARK_PALETTE: readonly string[] = [
  '#ff9b5e', // apricot
  '#e2b64a', // gold
  '#a9d15b', // lime
  '#5fd7b0', // mint
  '#63c8ee', // sky
  '#9fb0ff', // periwinkle
  '#cf9bf2', // lilac
  '#f28cc0', // rose
];

export const LIGHT_GROUND = '#fdf6e3';
export const DARK_GROUND = '#002b36';

// Stable index into the palette from any string id. FNV-1a, 32-bit: cheap,
// well-distributed for uuid-shaped input, and identical in every browser.
export function paletteIndex(id: string, size: number = LIGHT_PALETTE.length): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % size;
}

export function collabColorFor(
  userId: string,
  isDark: boolean,
): { color: string; colorLight: string } {
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  const color = palette[paletteIndex(userId, palette.length)]!;
  return { color, colorLight: `${color}${isDark ? '59' : '40'}` };
}

// Display name for the caret label: the display name the header
// already uses, else the mailbox half of the email, never "Anonymous".
export function collabNameFor(user: { name: string | null; email: string }): string {
  const name = user.name?.trim();
  if (name) return name;
  return user.email.split('@')[0] || user.email;
}

export function collabUserFor(
  user: { id: string; name: string | null; email: string },
  isDark: boolean,
): CollabUser {
  return { name: collabNameFor(user), ...collabColorFor(user.id, isDark) };
}
