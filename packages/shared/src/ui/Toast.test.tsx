// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TOAST_TIMEOUT_MS, ToastHost, toastStore, useToasts } from './Toast.js';

function clearStore(): void {
  for (const item of [...toastStore.items]) toastStore.dismiss(item.id);
}

afterEach(() => {
  cleanup();
  clearStore();
  vi.useRealTimers();
});

describe('toastStore', () => {
  it('push adds an item with a fresh id and dismiss removes it', () => {
    toastStore.push({ kind: 'info', message: 'one' });
    toastStore.push({ kind: 'success', message: 'two' });
    expect(toastStore.items.map((it) => it.message)).toEqual(['one', 'two']);
    const [first, second] = toastStore.items;
    expect(first.id).not.toBe(second.id);

    toastStore.dismiss(first.id);
    expect(toastStore.items.map((it) => it.message)).toEqual(['two']);
  });

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const seen: string[][] = [];
    function Probe() {
      const [list] = useToasts();
      seen.push(list.map((it) => it.message));
      return null;
    }
    const { unmount } = render(<Probe />);
    act(() => toastStore.push({ kind: 'info', message: 'hello' }));
    expect(seen.at(-1)).toEqual(['hello']);

    unmount();
    const renders = seen.length;
    act(() => toastStore.push({ kind: 'info', message: 'after' }));
    expect(seen.length).toBe(renders);
  });
});

describe('ToastHost', () => {
  it('auto-dismisses a toast after the timeout', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => toastStore.push({ kind: 'info', message: 'Saved' }));
    expect(screen.getByTestId('toast-info').textContent).toContain('Saved');

    act(() => {
      vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1);
    });
    expect(screen.queryByTestId('toast-info')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('toast-info')).toBeNull();
    expect(toastStore.items).toEqual([]);
  });

  it('mounts a polite status region and an assertive alert region before any toast exists', () => {
    render(<ToastHost />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
  });

  it('routes info/success toasts to the polite region and errors to the assertive one', () => {
    render(<ToastHost />);
    act(() => {
      toastStore.push({ kind: 'success', message: 'Checkpoint created' });
      toastStore.push({ kind: 'error', message: 'Delete failed' });
    });
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status.contains(screen.getByTestId('toast-success'))).toBe(true);
    expect(alert.contains(screen.getByTestId('toast-error'))).toBe(true);
    expect(status.contains(screen.getByTestId('toast-error'))).toBe(false);
  });

  it('every toast has a Dismiss button that removes it immediately', () => {
    render(<ToastHost />);
    act(() => toastStore.push({ kind: 'info', message: 'Copied' }));
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.closest('[data-testid="toast-info"]')).not.toBeNull();

    fireEvent.click(dismiss);
    expect(screen.queryByTestId('toast-info')).toBeNull();
    expect(toastStore.items).toEqual([]);
  });

  it('toasts accept pointer events even though the host wrapper does not', () => {
    render(<ToastHost />);
    act(() => toastStore.push({ kind: 'info', message: 'Copied' }));
    const toast = screen.getByTestId('toast-info');
    expect(toast.className).toContain('pointer-events-auto');
  });

  it('styles the error kind with the danger role tokens, not accent', () => {
    render(<ToastHost />);
    act(() => toastStore.push({ kind: 'error', message: 'Restore failed' }));
    const cls = screen.getByTestId('toast-error').className;
    expect(cls).toContain('border-danger-border');
    expect(cls).toContain('bg-danger-bg-alt');
    expect(cls).toContain('text-danger-fg-strong');
    expect(cls).not.toContain('accent');
  });
});
