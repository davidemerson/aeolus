import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export type RightPaneTab = 'pdf' | 'logs';

const TABS: RightPaneTab[] = ['pdf', 'logs'];

export const RIGHT_PANE_PANEL_ID = 'right-pane-panel';
export function rightPaneTabId(tab: RightPaneTab): string {
  return `right-pane-tab-${tab}`;
}

interface RightPaneTabsProps {
  active: RightPaneTab;
  onChange: (tab: RightPaneTab) => void;
  // Badge rendered inside the logs tab (the "!" on a failed compile or
  // the warning count). Owned by the host, which knows the compile state.
  logsBadge?: ReactNode;
}

// The pdf / logs switch above the right pane, as a real tab list: the
// active tab is the only one in the tab order, Left/Right/Home/End move
// between tabs and select as they go (automatic activation — there are
// two tabs and switching is instant), and the panel the host renders
// declares itself with `rightPanePanelProps(active)`.
export function RightPaneTabs({ active, onChange, logsBadge }: RightPaneTabsProps) {
  const refs = useRef<Record<RightPaneTab, HTMLButtonElement | null>>({ pdf: null, logs: null });

  const select = (tab: RightPaneTab): void => {
    onChange(tab);
    refs.current[tab]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const idx = TABS.indexOf(active);
    let next: RightPaneTab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  return (
    <div
      role="tablist"
      aria-label="Preview or compile output"
      className="flex items-center border-b border-hairline-strong bg-surface"
    >
      {TABS.map((tab) => {
        const selected = tab === active;
        return (
          <button
            key={tab}
            ref={(el) => {
              refs.current[tab] = el;
            }}
            type="button"
            role="tab"
            id={rightPaneTabId(tab)}
            aria-selected={selected}
            aria-controls={RIGHT_PANE_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab)}
            onKeyDown={onKeyDown}
            data-testid={`right-pane-tab-${tab}`}
            className={`flex items-center gap-2 px-5 py-2.5 font-mono text-[11px] uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
              selected
                ? 'border-b-2 border-focus text-body'
                : 'border-b-2 border-transparent text-muted hover:text-body-2'
            }`}
          >
            {tab}
            {tab === 'logs' ? logsBadge : null}
          </button>
        );
      })}
    </div>
  );
}

/** Attributes for the element that holds the active tab's content. */
export function rightPanePanelProps(active: RightPaneTab): {
  role: 'tabpanel';
  id: string;
  'aria-labelledby': string;
} {
  return { role: 'tabpanel', id: RIGHT_PANE_PANEL_ID, 'aria-labelledby': rightPaneTabId(active) };
}
