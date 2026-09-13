import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@aeolus/shared/ui';

export interface CommandAction {
  id: string;
  label: string;
  // Short caption rendered next to the label so the user knows what
  // a preset is about to do without having to read the instruction
  // verbatim.
  hint?: string;
  instruction: string;
  needsCustomInstruction?: boolean;
}

const PRESET_ACTIONS: CommandAction[] = [
  {
    id: 'ask',
    label: 'Ask Claude about selection',
    hint: 'free-form prompt',
    instruction: '',
    needsCustomInstruction: true,
  },
  {
    id: 'tighten',
    label: 'Tighten this paragraph',
    hint: 'concise rewrite',
    instruction: 'Tighten this paragraph — make it more concise while preserving meaning.',
  },
  {
    id: 'cleanup',
    label: 'Clean up code',
    hint: 'normalise + modernise the source',
    instruction:
      'Review this LaTeX/Typst source for coherence and optimisation. Apply improvements that: modernise deprecated commands, remove redundant or unused declarations, normalise formatting (consistent indentation, whitespace, line breaks), replace verbose constructs with idiomatic alternatives where the meaning is preserved, and fix obvious typos / stylistic inconsistencies. Preserve every author intent: do not remove content, do not rewrite prose, do not change semantic structure (sectioning, theorem environments, citations, labels). Output only the cleaned source — no explanation, no markdown fences, no diff.',
  },
  {
    id: 'theorem',
    label: 'Convert to theorem environment',
    hint: 'wrap selection',
    instruction: 'Convert this to a LaTeX theorem environment (\\begin{theorem}...\\end{theorem}).',
  },
  {
    id: 'bib',
    label: 'Fix bibliography',
    hint: 'consistent .bib entry',
    instruction: 'Fix any formatting or consistency issues in this bibliography entry.',
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (instruction: string) => void;
}

// Same field treatment as the shared Input, with the focus ring — the
// palette's filter is the first thing keyboard users land on.
const fieldClass =
  'block w-full rounded border border-hairline-strong bg-surface px-3 py-2 font-mono text-[13px] text-body placeholder-placeholder transition-colors focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus';

export function CommandPalette({ open, onClose, onSubmit }: Props) {
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [customInstruction, setCustomInstruction] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Element that had focus when the palette opened. Restored on
  // close so screen-reader and keyboard-only users land back where
  // they started instead of on document.body.
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const listboxId = useId();

  const filtered = PRESET_ACTIONS.filter((a) =>
    a.label.toLowerCase().includes(filter.toLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setSelectedIdx(0);
    setCustomMode(false);
    setCustomInstruction('');
    openerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      // Restore focus on close. Guard against the opener no longer
      // being in the document (route nav between open and close).
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus();
      openerRef.current = null;
    };
  }, [open]);

  const handleSelect = useCallback(
    (action: CommandAction) => {
      if (action.needsCustomInstruction) {
        setCustomMode(true);
        return;
      }
      onSubmit(action.instruction);
      onClose();
    },
    [onSubmit, onClose],
  );

  const handleCustomSubmit = useCallback(() => {
    if (customInstruction.trim()) {
      onSubmit(customInstruction.trim());
      onClose();
    }
  }, [customInstruction, onSubmit, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Trap Tab inside the dialog so focus doesn't escape behind
      // the modal. Shift+Tab from the first element wraps to the
      // last and vice versa.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length > 0) {
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }

      if (customMode) {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleCustomSubmit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setCustomMode(false);
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIdx]) handleSelect(filtered[selectedIdx]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [customMode, filtered, selectedIdx, handleSelect, handleCustomSubmit, onClose],
  );

  if (!open) return null;

  const activeOptionId =
    !customMode && filtered[selectedIdx] ? `command-action-${filtered[selectedIdx].id}` : undefined;

  return (
    // The scrim. role="presentation" says what it is: a click-anywhere-
    // outside target with no meaning of its own — keyboard users close
    // with Escape, handled on the dialog. The click only counts when it
    // lands on the scrim itself, so nothing inside the dialog has to stop
    // propagation.
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center bg-backdrop pt-[20vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="command-palette-backdrop"
    >
      {/* A native <dialog> (shown with the `open` attribute, positioned by
          the flex scrim rather than the UA's absolute centring) so the
          keyboard handling sits on an element that is a dialog, not a div
          pretending to be one. */}
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative m-0 w-full max-w-lg rounded-card border border-hairline-strong bg-surface p-0 text-body shadow-dialog"
        onKeyDown={handleKeyDown}
        data-testid="command-palette"
      >
        <h2 id={titleId} className="sr-only">
          Claude
        </h2>
        {customMode ? (
          <div className="p-5">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">
              // claude
            </div>
            <input
              ref={inputRef}
              autoFocus
              aria-label="What should Claude do with the selection?"
              className={fieldClass}
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder="e.g. rewrite in passive voice…"
              data-testid="command-palette-custom-input"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="mono" onClick={() => setCustomMode(false)}>
                ← back
              </Button>
              <Button
                variant="primary"
                disabled={!customInstruction.trim()}
                onClick={handleCustomSubmit}
                data-testid="command-palette-submit"
              >
                Send
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="border-b border-hairline-strong p-3">
              <div className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                // claude
              </div>
              <input
                ref={inputRef}
                autoFocus
                role="combobox"
                aria-label="Filter actions"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
                className={fieldClass}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setSelectedIdx(0);
                }}
                placeholder="filter actions…"
                data-testid="command-palette-filter"
              />
            </div>
            <ul id={listboxId} role="listbox" className="max-h-72 overflow-auto py-1">
              {filtered.map((action, i) => (
                // The option is a button so a pointer and a switch device
                // both activate it natively; it stays out of the tab order
                // (the combobox drives selection through
                // aria-activedescendant) and a mousedown does not steal
                // focus from the filter field.
                <li key={action.id} role="none">
                  <button
                    type="button"
                    id={`command-action-${action.id}`}
                    role="option"
                    aria-selected={i === selectedIdx}
                    tabIndex={-1}
                    className={`flex w-full cursor-pointer items-baseline justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                      i === selectedIdx ? 'bg-fill-warm text-body' : 'text-body-2 hover:bg-page'
                    }`}
                    onMouseEnter={() => setSelectedIdx(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelect(action)}
                    data-testid={`command-action-${action.id}`}
                  >
                    <span>{action.label}</span>
                    {action.hint ? (
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted">
                        {action.hint}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-4 py-2 font-mono text-[11px] text-muted">no matching actions</li>
              )}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-muted">
              <span>↑↓ navigate · ↵ run · esc close</span>
              <span>
                {filtered.length} action{filtered.length === 1 ? '' : 's'}
              </span>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
