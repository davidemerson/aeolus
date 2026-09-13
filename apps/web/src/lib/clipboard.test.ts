import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from './clipboard.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubClipboard(clipboard: unknown): void {
  vi.stubGlobal('navigator', { ...navigator, clipboard });
}

describe('copyToClipboard', () => {
  it('uses navigator.clipboard.writeText when it exists', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({ writeText });
    await expect(copyToClipboard('aeolus_abc')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('aeolus_abc');
  });

  it('falls back to a temporary textarea + execCommand on an insecure origin', async () => {
    stubClipboard(undefined);
    const execCommand = vi.fn((cmd: string) => cmd === 'copy');
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
      writable: true,
    });
    try {
      await expect(copyToClipboard('fallback text')).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith('copy');
      // The scratch element does not linger in the document.
      expect(document.querySelectorAll('textarea')).toHaveLength(0);
    } finally {
      // happy-dom has no execCommand of its own; remove the one we added.
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
  });

  it('reports false, without throwing, when neither path is available', async () => {
    stubClipboard(undefined);
    expect(typeof document.execCommand).toBe('undefined');
    await expect(copyToClipboard('nothing')).resolves.toBe(false);
  });

  it('reports false, without throwing, when writeText rejects', async () => {
    stubClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('denied'))) });
    await expect(copyToClipboard('denied')).resolves.toBe(false);
  });
});
