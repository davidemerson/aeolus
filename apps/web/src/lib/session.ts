import { useEffect, useState } from 'react';

import { api, type Me } from './api.js';

export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; user: Me['user'] }
  | { status: 'anonymous' };

const listeners = new Set<(state: SessionState) => void>();
let current: SessionState = { status: 'loading' };

function emit(next: SessionState): void {
  current = next;
  for (const l of listeners) l(next);
}

let inflight: Promise<SessionState> | null = null;

export function refreshSession(): Promise<SessionState> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const me = await api.get<Me>('/me');
      emit({ status: 'authenticated', user: me.user });
    } catch {
      emit({ status: 'anonymous' });
    }
    inflight = null;
    return current;
  })();
  return inflight;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(current);
  useEffect(() => {
    const listener = (next: SessionState) => setState(next);
    listeners.add(listener);
    if (current.status === 'loading') {
      void refreshSession();
    } else {
      setState(current);
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

export function clearSession(): void {
  emit({ status: 'anonymous' });
}
