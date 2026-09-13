import { useCallback, useEffect, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastStore {
  items: ToastItem[];
  push: (item: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;
const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];

function emit() {
  for (const listener of listeners) listener(items);
}

export const toastStore: ToastStore = {
  get items() {
    return items;
  },
  push(item) {
    const entry: ToastItem = { id: nextId++, ...item };
    items = [...items, entry];
    emit();
  },
  dismiss(id) {
    items = items.filter((it) => it.id !== id);
    emit();
  },
};

export function useToasts(): [ToastItem[], (item: Omit<ToastItem, 'id'>) => void] {
  const [state, setState] = useState<ToastItem[]>(items);
  useEffect(() => {
    const listener = (next: ToastItem[]) => setState(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const push = useCallback((item: Omit<ToastItem, 'id'>) => toastStore.push(item), []);
  return [state, push];
}

export const TOAST_TIMEOUT_MS = 4000;

// Error toasts use the danger role, not accent: accent is the brand orange
// used for emphasis and links, and a failure painted in it reads as a
// highlight rather than a problem. The three role tokens mirror success.
const kinds: Record<ToastKind, string> = {
  info: 'border-hairline-strong bg-surface text-body',
  success: 'border-success-border bg-success-bg-alt text-success-fg-strong',
  error: 'border-danger-border bg-danger-bg-alt text-danger-fg-strong',
};

export function Toast({ item }: { item: ToastItem }) {
  useEffect(() => {
    const handle = setTimeout(() => toastStore.dismiss(item.id), TOAST_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [item.id]);
  return (
    <div
      data-testid={`toast-${item.kind}`}
      className={`pointer-events-auto flex items-start gap-3 rounded border px-4 py-2 text-sm shadow-card ${kinds[item.kind]}`}
    >
      <span className="min-w-0 flex-1">{item.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => toastStore.dismiss(item.id)}
        className="-mr-1 shrink-0 rounded-badge px-1 leading-none opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        ×
      </button>
    </div>
  );
}

// Two live regions, both mounted from the start so assistive tech is already
// watching them when a toast lands (a live region created together with its
// content is often not announced). Info and success are polite; errors are
// assertive. The outer wrapper stays pointer-events-none so the empty corner
// never swallows clicks; each toast re-enables pointer events for its dismiss
// button.
export function ToastHost() {
  const [list] = useToasts();
  const polite = list.filter((item) => item.kind !== 'error');
  const assertive = list.filter((item) => item.kind === 'error');
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 flex w-80 flex-col gap-2 print:hidden">
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        {polite.map((item) => (
          <Toast key={item.id} item={item} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
        {assertive.map((item) => (
          <Toast key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
