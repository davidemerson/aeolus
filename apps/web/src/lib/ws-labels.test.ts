import { describe, expect, it } from 'vitest';

import { authFailedMessage, wsStatusLabel } from './ws-labels.js';

describe('wsStatusLabel', () => {
  it('maps every hook status to a readable label', () => {
    expect(wsStatusLabel('connecting')).toBe('Connecting…');
    expect(wsStatusLabel('connected')).toBe('Connected');
    expect(wsStatusLabel('reconnecting')).toBe('Reconnecting…');
    expect(wsStatusLabel('error')).toBe('Offline');
  });
});

describe('authFailedMessage', () => {
  it('turns the server reason into a sentence with no codes in it', () => {
    expect(authFailedMessage('forbidden')).toBe('You no longer have access to this document.');
    expect(authFailedMessage('not_found')).toBe('This document was deleted.');
    expect(authFailedMessage('invalid_ticket')).toBe('Your session expired. Reload to reconnect.');
    expect(authFailedMessage('invalid_session')).toBe('Your session expired. Reload to reconnect.');
    expect(authFailedMessage('no_session')).toBe('Your session expired. Reload to reconnect.');
    expect(authFailedMessage('expired')).toBe('Your session expired. Reload to reconnect.');
  });

  it('falls back to a generic sentence for anything else, never echoing the token', () => {
    const msg = authFailedMessage('auth_rejected');
    expect(msg).toBe('The connection was rejected. Reload to try again.');
    expect(msg).not.toContain('auth_rejected');
    expect(authFailedMessage('')).toBe('The connection was rejected. Reload to try again.');
  });
});
