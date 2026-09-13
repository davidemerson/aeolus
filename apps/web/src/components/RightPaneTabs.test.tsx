import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { RightPaneTabs, rightPanePanelProps, type RightPaneTab } from './RightPaneTabs.js';

afterEach(() => {
  cleanup();
});

function Harness({ onChange }: { onChange?: (t: RightPaneTab) => void }) {
  const [active, setActive] = useState<RightPaneTab>('pdf');
  return (
    <>
      <RightPaneTabs
        active={active}
        onChange={(t) => {
          setActive(t);
          onChange?.(t);
        }}
        logsBadge={<span data-testid="badge">!</span>}
      />
      <div {...rightPanePanelProps(active)} data-testid="panel">
        {active}
      </div>
    </>
  );
}

describe('RightPaneTabs', () => {
  it('exposes tablist / tab / tabpanel semantics wired together', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    const pdf = screen.getByTestId('right-pane-tab-pdf');
    const logs = screen.getByTestId('right-pane-tab-logs');
    expect(pdf.getAttribute('aria-selected')).toBe('true');
    expect(logs.getAttribute('aria-selected')).toBe('false');
    // Only the active tab is in the tab order.
    expect(pdf.getAttribute('tabindex')).toBe('0');
    expect(logs.getAttribute('tabindex')).toBe('-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(pdf.id);
    expect(pdf.getAttribute('aria-controls')).toBe(panel.id);
    // The host's badge lands inside the logs tab.
    expect(logs.contains(screen.getByTestId('badge'))).toBe(true);
  });

  it('clicking a tab selects it and relabels the panel', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId('right-pane-tab-logs'));
    expect(onChange).toHaveBeenCalledWith('logs');
    expect(screen.getByTestId('right-pane-tab-logs').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'right-pane-tab-logs',
    );
    expect(screen.getByTestId('panel').textContent).toBe('logs');
  });

  it('arrow keys move between tabs, wrapping, and Home/End jump', () => {
    render(<Harness />);
    const pdf = screen.getByTestId('right-pane-tab-pdf');
    const logs = screen.getByTestId('right-pane-tab-logs');
    pdf.focus();

    fireEvent.keyDown(pdf, { key: 'ArrowRight' });
    expect(logs.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(logs);

    // Wraps from the last tab back to the first.
    fireEvent.keyDown(logs, { key: 'ArrowRight' });
    expect(pdf.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(pdf);

    fireEvent.keyDown(pdf, { key: 'ArrowLeft' });
    expect(logs.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(logs, { key: 'Home' });
    expect(pdf.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(pdf, { key: 'End' });
    expect(logs.getAttribute('aria-selected')).toBe('true');
  });

  it('ignores other keys', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(screen.getByTestId('right-pane-tab-pdf'), { key: 'ArrowDown' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
