import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';

import { type ThreadView } from './comments.js';

// CodeMirror integration for inline-comments. We expose a single
// extension factory (`commentsHighlight`) plus an effect that the
// host dispatches whenever the threads array changes. The extension
// renders an underline mark over each anchored range so authors can
// see at a glance where comments are attached.
//
// Decoration is store-shaped (StateField holds the latest set) so
// it survives Yjs updates without re-running on every keystroke —
// the host updates it via `setThreadsEffect.of(threads)` only when
// the threads list actually changed.

export const setThreadsEffect = StateEffect.define<ThreadView[]>();

const commentMark = Decoration.mark({
  class: 'cm-comment-mark',
  attributes: { 'data-testid': 'cm-comment-mark' },
});

function buildDecorations(threads: ThreadView[], docLength: number): DecorationSet {
  const sorted = threads
    .filter((t) => !t.resolved && t.from !== null && t.to !== null)
    .map((t) => ({
      from: Math.max(0, Math.min(t.from!, docLength)),
      to: Math.max(0, Math.min(t.to!, docLength)),
    }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of sorted) {
    builder.add(r.from, r.to, commentMark);
  }
  return builder.finish();
}

const threadsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    let decorations = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setThreadsEffect)) {
        decorations = buildDecorations(effect.value, tr.state.doc.length);
      }
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The mark reads the accent token rather than a hard-coded brand-500
// rgba, so it follows tokens.css (and any future re-tint) and picks up
// the theme's value at paint time. color-mix keeps the wash translucent
// so the selection highlight underneath still shows through.
export function commentsHighlightExtensions() {
  return [
    threadsField,
    EditorView.theme({
      '.cm-comment-mark': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
        borderBottom: '2px solid color-mix(in srgb, var(--accent) 70%, transparent)',
      },
    }),
  ];
}
