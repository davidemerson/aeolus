import { useEffect, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';

interface UseDocEditorKeysOptions {
  focusMode: boolean;
  setFocusMode: (next: boolean | ((prev: boolean) => boolean)) => void;
  setCmdPaletteOpen: (open: boolean) => void;
  triggerCompile: () => Promise<void> | void;
  // Used to scope Cmd/Ctrl+A to the editor when focus is on
  // page chrome (buttons, status bar) rather than a real text
  // input. Optional so non-editor consumers can ignore it.
  editorViewRef?: RefObject<EditorView | null>;
  // Cmd/Ctrl+J → jump from cursor to PDF page (forward synctex).
  // Optional: when omitted the binding is silently inert.
  onShowInPdf?: () => void;
}

// Single window-level keybindings handler for the doc editor:
//   - Esc          → exit focus mode (only when focusMode === true)
//   - Cmd/Ctrl+K   → open command palette
//   - Cmd/Ctrl+S   → trigger compile (intercept browser save dialog)
//   - Cmd/Ctrl+.   → toggle focus mode
//   - Cmd/Ctrl+J   → forward synctex jump (cursor → PDF page)
//   - Cmd/Ctrl+A   → select all in the editor (when focus is on
//                    page chrome, not in another text field)
// Lifted out of doc-editor.tsx so the keybinding contract is unit-
// testable without spinning up CodeMirror + Yjs.
export function useDocEditorKeys({
  focusMode,
  setFocusMode,
  setCmdPaletteOpen,
  triggerCompile,
  editorViewRef,
  onShowInPdf,
}: UseDocEditorKeysOptions): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && focusMode) {
        e.preventDefault();
        setFocusMode(false);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen(true);
      } else if (key === 's') {
        e.preventDefault();
        void triggerCompile();
      } else if (key === 'j' && onShowInPdf) {
        e.preventDefault();
        onShowInPdf();
      } else if (e.key === '.') {
        e.preventDefault();
        setFocusMode((v) => !v);
      } else if (key === 'a') {
        const view = editorViewRef?.current;
        if (!view) return;
        const ae = document.activeElement as HTMLElement | null;
        // If focus is in CM's own contentEditable, the editor's
        // keymap handles selectAll natively — leave it alone.
        if (ae && view.contentDOM.contains(ae)) return;
        // If focus is in any other text input, let the browser do
        // its native select-all on that input.
        const tag = ae?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (ae?.isContentEditable ?? false)) {
          return;
        }
        // Otherwise: focus is on a button, the body, or some other
        // non-text element, and the browser would select the entire
        // page. Redirect to the editor's selectAll instead.
        e.preventDefault();
        view.focus();
        view.dispatch({
          selection: { anchor: 0, head: view.state.doc.length },
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusMode, setFocusMode, setCmdPaletteOpen, triggerCompile, editorViewRef, onShowInPdf]);
}
