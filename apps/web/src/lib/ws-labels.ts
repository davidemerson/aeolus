import type { WsStatus } from '../hooks/useDocWsConnection.js';

// The indicator beside the document title. The hook's status values are
// internal names; these are what a person reads.
export function wsStatusLabel(status: WsStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'error':
      return 'Offline';
  }
}

// The banner shown when the live session is rejected for good. `reason` is
// the server's close reason or the ticket-mint error code (lib/ws-ticket.ts);
// none of those tokens are for the reader, so every branch is a sentence.
export function authFailedMessage(reason: string): string {
  switch (reason) {
    case 'forbidden':
      return 'You no longer have access to this document.';
    case 'not_found':
      return 'This document was deleted.';
    case 'invalid_ticket':
    case 'invalid_session':
    case 'no_session':
    case 'expired':
      return 'Your session expired. Reload to reconnect.';
    default:
      return 'The connection was rejected. Reload to try again.';
  }
}
