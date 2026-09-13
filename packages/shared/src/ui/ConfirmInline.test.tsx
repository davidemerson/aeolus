// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ConfirmInline } from './ConfirmInline.js';

afterEach(() => {
  cleanup();
});

describe('ConfirmInline', () => {
  it('renders the message and both buttons, with focus on Cancel', () => {
    render(
      <ConfirmInline
        message="Delete this snapshot?"
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Delete this snapshot?')).toBeTruthy();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(document.activeElement).toBe(cancel);
  });

  it('labels the group with the message', () => {
    render(
      <ConfirmInline
        message="Restore every file?"
        confirmLabel="Restore"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('group', { name: 'Restore every file?' })).toBeTruthy();
  });

  it('Escape cancels without confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmInline
        message="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Focus moved to Confirm (Tab) — Escape still backs out from there.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Delete' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clicking Confirm calls onConfirm, clicking Cancel calls onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmInline
        message="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
        testId="cp-delete"
      />,
    );
    fireEvent.click(screen.getByTestId('cp-delete-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('cp-delete-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('pending disables both buttons and ignores Escape', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmInline
        message="Delete?"
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={onCancel}
        pending
      />,
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBe('true');
    fireEvent.keyDown(cancel, { key: 'Escape' });
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('destructive uses the danger button, otherwise primary', () => {
    const { unmount } = render(
      <ConfirmInline
        message="Delete?"
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
        destructive
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-btn-danger');
    unmount();

    render(
      <ConfirmInline
        message="Restore?"
        confirmLabel="Restore"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Restore' }).className).toContain('bg-btn-primary');
  });
});
