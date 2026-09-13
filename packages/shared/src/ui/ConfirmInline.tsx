import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { Button } from './Button.js';

export interface ConfirmInlineProps {
  // What the person is about to do, as a sentence ("Delete this snapshot?").
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  // True while the confirmed request is in flight: both buttons disable so a
  // double click cannot fire it twice, and Escape stops cancelling.
  pending?: boolean;
  // Destructive actions get the danger button; everything else primary.
  destructive?: boolean;
  // Test-id prefix: renders `${testId}-confirm` and `${testId}-cancel`.
  testId?: string;
  className?: string;
}

// The inline two-step confirm used wherever a modal would be too heavy: the
// triggering button swaps for a short sentence plus Cancel / Confirm. Focus
// lands on Cancel when it appears so a stray Enter cannot confirm, and Escape
// backs out. Modelled on the delete confirm in the workspace list.
export function ConfirmInline({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  pending = false,
  destructive = false,
  testId,
  className = '',
}: ConfirmInlineProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // On the two buttons rather than the wrapping group: keyboard events belong
  // to the element that has focus, and only Cancel / Confirm ever do here.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape' && !pending) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      role="group"
      aria-labelledby={messageId}
      aria-busy={pending || undefined}
      data-testid={testId}
      className={`flex flex-wrap items-center gap-2 ${className}`.trim()}
    >
      <span id={messageId} className="text-xs text-body-2">
        {message}
      </span>
      <Button
        ref={cancelRef}
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={onCancel}
        onKeyDown={onKeyDown}
        data-testid={testId ? `${testId}-cancel` : undefined}
      >
        Cancel
      </Button>
      <Button
        variant={destructive ? 'danger' : 'primary'}
        size="sm"
        disabled={pending}
        onClick={onConfirm}
        onKeyDown={onKeyDown}
        data-testid={testId ? `${testId}-confirm` : undefined}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}
