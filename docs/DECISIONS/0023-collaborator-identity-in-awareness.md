# 0023 — Collaborator identity in awareness: name from the session, colour from the user id

- **Status**: accepted
- **Date**: 2026-09-12
- **Deciders**: David Emerson
- **Supersedes/relates**: ADR 0013 (per-file Yjs persistence — the rooms this rides on); issue #68

## Context

Aeolus's editor uses `y-codemirror.next`, which colours and labels each
remote caret from `awareness.state.user = { name, color, colorLight }`. The
app never set that field, so the library's fallback applied to everyone:
one cyan caret, labelled "Anonymous", with a 20%-alpha selection tint.
In a two-person session you could not tell whose cursor was whose; in a
three-person session you could not tell how many people were there. The
dark editor theme (#67) made it slightly worse — 20% alpha on Solarized
base03 is nearly invisible.

Fixing it is a small feature, not a rename, and it has three decisions in
it that are worth writing down so the next person does not re-derive them.

## Decision

1. **Name comes from the session, never from the room.** `collabNameFor`
   takes the display name `/api/me` already returns — `users.name`, which
   a person sets for themselves on the Settings page — and falls back to
   the mailbox half of their email when it is empty. The app header uses
   the same value, so a caret label and the header agree. There is no
   "Anonymous" path: every connection is authenticated, so every caret has
   a person behind it.

2. **Colour is a pure function of the user id.** FNV-1a (32-bit) over the id,
   modulo the palette size. No assignment on join, no persistence, no
   coordination between tabs: a given person is the same colour to everyone
   in the room, across reloads, and across documents. Two users can share a
   hue (eight slots), which is acceptable for a tool whose rooms are small;
   the label disambiguates.

3. **Two palettes, one per editor ground, checked mechanically.** Eight hues
   for Solarized base3 (light) and eight for base03 (dark), the same slot on
   both so a person keeps their hue across themes. The palette file states
   the numbers and `collab-colors.test.ts` recomputes them from the hex
   values: pairwise CIE76 ΔE ≥ 20 (measured 22.9 light / 22.8 dark), caret
   ≥ 3:1 against its ground (3.95–5.05 / 6.64–8.55), label text ≥ 4:1 on
   the caret. The label text colour flips with the ground — white on the
   light palette, base03 on the dark one — because white on the bright
   carets the dark ground needs measures ~2:1. Selection tint is 25% alpha
   on light, 35% on dark.

The caret label also loses y-codemirror's `serif` in favour of the
editor's own mono stack (`monoStack` in `editor-theme.ts`: JetBrains Mono
with system monospace fallbacks), so it stops being the only serif in the
app.

## Alternatives considered

- **Server-assigned colours** (the ws room hands out the next free hue on
  join). Rejected: it needs state per room, differs per document, and
  changes on every reconnect — the opposite of "the same person looks the
  same".
- **Reuse the app's semantic hues** (`--success`, `--warning`, `--info`,
  `--danger`, accent). Rejected: five hues, each already carrying a
  meaning (a red caret reads as an error), and only three of them are
  distinguishable from each other by ΔE on both grounds.
- **One palette for both grounds.** Rejected on measurement: a hue with
  ≥ 4:1 contrast on base3 has < 3:1 on base03 and vice versa.

## Consequences

- Remote carets show the collaborator's name and a stable per-person colour;
  the selection tint is visible on both grounds.
- A palette edit that breaks distinguishability fails the unit suite.
- The #55 console probes (`[useDocWsConnection] …`), shipped 2026-05-04 and
  never reported firing, were removed in the same change; #55 closes as
  not reproduced and reopens with console output if it recurs.
