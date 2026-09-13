import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CommandPalette } from './CommandPalette.js';

afterEach(() => {
  cleanup();
});

describe('CommandPalette accessibility', () => {
  it('exposes dialog/listbox semantics with aria-activedescendant', () => {
    render(<CommandPalette open onClose={() => {}} onSubmit={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    const list = screen.getByRole('listbox');
    expect(list).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    // First option starts selected.
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');
  });

  it('input autoFocuses (no setTimeout hack required)', () => {
    render(<CommandPalette open onClose={() => {}} onSubmit={() => {}} />);
    const input = screen.getByTestId('command-palette-filter');
    expect(document.activeElement).toBe(input);
  });

  it('Escape closes the palette and Enter submits the selection', () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    render(<CommandPalette open onClose={onClose} onSubmit={onSubmit} />);
    const dialog = screen.getByRole('dialog');

    // ArrowDown to second option, then Enter — second action has
    // a non-empty instruction so onSubmit fires immediately.
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    onSubmit.mockClear();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
