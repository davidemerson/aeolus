import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import type { EditorView } from '@codemirror/view';

import { useDocEditorKeys } from './use-doc-editor-keys.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

type Opts = Parameters<typeof useDocEditorKeys>[0];
interface Harness {
  focusMode: boolean;
  setFocusMode: Mock<Opts['setFocusMode']>;
  setCmdPaletteOpen: Mock<Opts['setCmdPaletteOpen']>;
  triggerCompile: Mock<Opts['triggerCompile']>;
}

function makeHarness(focusMode = false): Harness {
  return {
    focusMode,
    // vitest 4 types a bare vi.fn() as Mock<Procedure>, which no longer
    // widens to a specific signature — name the signature.
    setFocusMode: vi.fn<Opts['setFocusMode']>(),
    setCmdPaletteOpen: vi.fn<Opts['setCmdPaletteOpen']>(),
    triggerCompile: vi.fn<Opts['triggerCompile']>(),
  };
}

function dispatch(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { cancelable: true, ...init });
  window.dispatchEvent(ev);
  return ev;
}

// Build a minimal EditorView-shaped stub. We don't spin up real
// CodeMirror — the hook only touches `contentDOM`, `focus`,
// `dispatch`, and `state.doc.length`.
function makeViewStub(opts: { docLength: number; contentEl: HTMLElement }): {
  view: EditorView;
  focus: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
} {
  const focus = vi.fn();
  const dispatch = vi.fn();
  const view = {
    contentDOM: opts.contentEl,
    focus,
    dispatch,
    state: { doc: { length: opts.docLength } },
  } as unknown as EditorView;
  return { view, focus, dispatch };
}

describe('useDocEditorKeys', () => {
  it('Cmd+. toggles focus mode and prevents default', () => {
    const h = makeHarness();
    renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
      }),
    );
    let ev: KeyboardEvent | undefined;
    act(() => {
      ev = dispatch({ key: '.', metaKey: true });
    });
    expect(h.setFocusMode).toHaveBeenCalledTimes(1);
    expect(ev?.defaultPrevented).toBe(true);
  });

  it('Esc exits focus mode only when focusMode is true', () => {
    // Off → Esc is a no-op (other Esc handlers in the route still work).
    const off = makeHarness(false);
    const { rerender } = renderHook(
      (props: Harness) =>
        useDocEditorKeys({
          focusMode: props.focusMode,
          setFocusMode: props.setFocusMode,
          setCmdPaletteOpen: props.setCmdPaletteOpen,
          triggerCompile: props.triggerCompile,
        }),
      { initialProps: off },
    );
    act(() => dispatch({ key: 'Escape' }));
    expect(off.setFocusMode).not.toHaveBeenCalled();

    // On → Esc exits.
    const on = makeHarness(true);
    rerender(on);
    act(() => dispatch({ key: 'Escape' }));
    expect(on.setFocusMode).toHaveBeenCalledWith(false);
  });

  it('Cmd+S triggers compile, Cmd+K opens palette, plain "." does nothing', () => {
    const h = makeHarness();
    renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
      }),
    );
    act(() => dispatch({ key: 's', metaKey: true }));
    expect(h.triggerCompile).toHaveBeenCalledTimes(1);
    act(() => dispatch({ key: 'k', metaKey: true }));
    expect(h.setCmdPaletteOpen).toHaveBeenCalledWith(true);
    // Plain "." (no modifier) shouldn't toggle — it's a normal
    // typed character.
    act(() => dispatch({ key: '.' }));
    expect(h.setFocusMode).not.toHaveBeenCalled();
  });

  it('Cmd+A redirects to editor selectAll when focus is on page chrome', () => {
    const h = makeHarness();
    const contentEl = document.createElement('div');
    document.body.appendChild(contentEl);
    const stub = makeViewStub({ docLength: 42, contentEl });
    const ref = createRef<EditorView | null>();
    (ref as { current: EditorView | null }).current = stub.view;
    // Focus a button (page chrome) — the browser would select the
    // whole page on Cmd+A here without our handler.
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
        editorViewRef: ref,
      }),
    );

    let ev: KeyboardEvent | undefined;
    act(() => {
      ev = dispatch({ key: 'a', metaKey: true });
    });
    expect(ev?.defaultPrevented).toBe(true);
    expect(stub.focus).toHaveBeenCalledTimes(1);
    expect(stub.dispatch).toHaveBeenCalledWith({
      selection: { anchor: 0, head: 42 },
    });
  });

  it('Cmd+A leaves a focused <input> alone (browser does its native select-all)', () => {
    const h = makeHarness();
    const contentEl = document.createElement('div');
    document.body.appendChild(contentEl);
    const stub = makeViewStub({ docLength: 10, contentEl });
    const ref = createRef<EditorView | null>();
    (ref as { current: EditorView | null }).current = stub.view;
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
        editorViewRef: ref,
      }),
    );

    let ev: KeyboardEvent | undefined;
    act(() => {
      ev = dispatch({ key: 'a', metaKey: true });
    });
    expect(ev?.defaultPrevented).toBe(false);
    expect(stub.dispatch).not.toHaveBeenCalled();
  });

  it('Cmd+A inside the editor contentDOM is left to CodeMirror', () => {
    const h = makeHarness();
    const contentEl = document.createElement('div');
    contentEl.contentEditable = 'true';
    document.body.appendChild(contentEl);
    const inner = document.createElement('span');
    contentEl.appendChild(inner);
    const stub = makeViewStub({ docLength: 10, contentEl });
    const ref = createRef<EditorView | null>();
    (ref as { current: EditorView | null }).current = stub.view;
    inner.tabIndex = 0;
    inner.focus();

    renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
        editorViewRef: ref,
      }),
    );

    let ev: KeyboardEvent | undefined;
    act(() => {
      ev = dispatch({ key: 'a', metaKey: true });
    });
    expect(ev?.defaultPrevented).toBe(false);
    expect(stub.dispatch).not.toHaveBeenCalled();
    expect(stub.focus).not.toHaveBeenCalled();
  });

  it('Cmd+J calls onShowInPdf when provided and prevents default', () => {
    const h = makeHarness();
    const onShowInPdf = vi.fn();
    const { unmount } = renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
        onShowInPdf,
      }),
    );
    let ev: KeyboardEvent | undefined;
    act(() => {
      ev = dispatch({ key: 'j', metaKey: true });
    });
    expect(onShowInPdf).toHaveBeenCalledTimes(1);
    expect(ev?.defaultPrevented).toBe(true);
    // Tear down explicitly so the next test starts with a clean
    // window — happy-dom's auto-cleanup didn't reliably do it for
    // these window-level listeners.
    unmount();
  });

  it('Cmd+J is inert when onShowInPdf is omitted', () => {
    const h = makeHarness();
    const { unmount } = renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
      }),
    );
    let ev: KeyboardEvent | undefined;
    act(() => {
      ev = dispatch({ key: 'j', metaKey: true });
    });
    expect(ev?.defaultPrevented).toBe(false);
    unmount();
  });

  it('removes its listener on unmount', () => {
    const h = makeHarness();
    const { unmount } = renderHook(() =>
      useDocEditorKeys({
        focusMode: h.focusMode,
        setFocusMode: h.setFocusMode,
        setCmdPaletteOpen: h.setCmdPaletteOpen,
        triggerCompile: h.triggerCompile,
      }),
    );
    unmount();
    act(() => dispatch({ key: '.', metaKey: true }));
    expect(h.setFocusMode).not.toHaveBeenCalled();
  });
});
