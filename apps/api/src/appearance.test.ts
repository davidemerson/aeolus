// The appearance control's server half. Worth testing rather than eyeballing
// because every failure here is silent:
//
//   - a junk cookie value reaches an HTML attribute;
//   - an `auto` written as a literal data-theme="auto" matches neither :root
//     nor :root[data-theme="dark"], pinning the app to light forever;
//   - a stamp regex that misses just leaves the page following the OS, which
//     looks like a working default rather than a bug.
import { describe, expect, it } from 'vitest';

import { readTheme, runtimeConfigFromEnv, stampConfig, stampTheme } from './appearance.js';

describe('readTheme', () => {
  it('reads the cookie out of a full header', () => {
    expect(readTheme('aeolus_theme=dark')).toBe('dark');
    expect(readTheme('foo=1; aeolus_theme=light; bar=2')).toBe('light');
    expect(readTheme('aeolus_session=abc; aeolus_theme=auto')).toBe('auto');
  });

  it('treats anything unrecognised as auto, never echoing it', () => {
    for (const junk of [
      undefined,
      '',
      'aeolus_theme=',
      'aeolus_theme=DARK',
      'aeolus_theme=purple',
      'aeolus_theme="dark"',
      'aeolus_theme=dark evil',
      'xaeolus_theme=dark',
      'aeolus_theme=dark" onload="alert(1)',
    ]) {
      expect(readTheme(junk), `${String(junk)} should be auto`).toBe('auto');
    }
  });

  it('does not mistake a similarly-named cookie for ours', () => {
    expect(readTheme('not_aeolus_theme=dark')).toBe('auto');
    expect(readTheme('aeolus_theme_old=dark')).toBe('auto');
  });
});

describe('stampTheme', () => {
  const shell = '<!doctype html>\n<html lang="en">\n<head></head>\n<body></body>\n</html>';

  it('injects data-theme for an explicit choice', () => {
    expect(stampTheme(shell, 'dark')).toMatch(/<html lang="en" data-theme="dark">/);
    expect(stampTheme(shell, 'light')).toMatch(/<html lang="en" data-theme="light">/);
  });

  it('writes NOTHING for auto', () => {
    // The CSS keys off the attribute being absent. A literal data-theme="auto"
    // would match no block at all and pin the app to light.
    expect(stampTheme(shell, 'auto')).toBe(shell);
  });

  it('leaves an already-stamped tag alone', () => {
    const stamped = '<html lang="en" data-theme="light">';
    expect(stampTheme(stamped, 'dark')).toBe(stamped);
  });

  it('rewrites the first html tag only', () => {
    const html = '<html lang="en"><body>about &lt;html&gt; tags</body></html>';
    const out = stampTheme(html, 'dark');
    expect(out.match(/data-theme/g)).toHaveLength(1);
    expect(out).toMatch(/<\/html>$/);
  });

  it('returns an unrecognised shell untouched rather than guessing', () => {
    // Falling back to "follow the OS" is the correct default, not a broken
    // state — so this must not throw or half-rewrite.
    const noHtmlTag = '<!doctype html>\n<body>hi</body>';
    expect(stampTheme(noHtmlTag, 'dark')).toBe(noHtmlTag);
  });
});

describe('stampConfig', () => {
  const shell =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';

  it('injects the config as non-executable JSON right after <head>', () => {
    const out = stampConfig(shell, { wsUrl: 'wss://ws.example.com' });
    expect(out).toContain(
      '<head><script type="application/json" id="aeolus-config">{"wsUrl":"wss://ws.example.com"}</script>',
    );
  });

  it('leaves the shell alone when there is nothing to say', () => {
    // The default is same-origin /ws, which needs no configuration at all.
    expect(stampConfig(shell, {})).toBe(shell);
  });

  it('escapes a closing tag so a value cannot end the element early', () => {
    const out = stampConfig(shell, { wsUrl: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script');
  });

  it('does not stamp twice', () => {
    const once = stampConfig(shell, { wsUrl: 'wss://a' });
    expect(stampConfig(once, { wsUrl: 'wss://b' })).toBe(once);
  });

  it('reads AEOLUS_WS_URL, and is empty without it', () => {
    expect(runtimeConfigFromEnv({ AEOLUS_WS_URL: 'wss://ws.example.com' })).toEqual({
      wsUrl: 'wss://ws.example.com',
    });
    expect(runtimeConfigFromEnv({})).toEqual({});
    expect(runtimeConfigFromEnv({ AEOLUS_WS_URL: '  ' })).toEqual({});
  });
});
