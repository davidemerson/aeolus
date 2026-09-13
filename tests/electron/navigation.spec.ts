import { describe, expect, it } from 'vitest';

import {
  appOrigin,
  isAllowedNavigation,
  isOpenableExternally,
} from '../../apps/electron/src/navigation.js';

// The shell's navigation policy (apps/electron/src/main.ts): stay on the app's
// own origin; hand everything else to the system browser. Pure functions, so
// no Electron needed.

const APP = 'https://aeolus.example.com';

describe('isAllowedNavigation', () => {
  it('allows the app itself, any path, any query', () => {
    expect(isAllowedNavigation(`${APP}/docs/abc?x=1#frag`, APP)).toBe(true);
    expect(isAllowedNavigation(`${APP}/guide`, APP)).toBe(true);
  });

  it('allows the sign-in form, which the app serves itself', () => {
    expect(isAllowedNavigation(`${APP}/login`, APP)).toBe(true);
    expect(isAllowedNavigation(`${APP}/passphrase`, APP)).toBe(true);
  });

  it('refuses other origins, including look-alikes and the http twin', () => {
    expect(isAllowedNavigation('https://example.com/', APP)).toBe(false);
    expect(isAllowedNavigation('https://aeolus.example.com.evil.example/', APP)).toBe(false);
    expect(isAllowedNavigation('http://aeolus.example.com/', APP)).toBe(false);
    expect(isAllowedNavigation('https://evil.example/aeolus.example.com', APP)).toBe(false);
  });

  it('refuses non-URLs and non-web schemes', () => {
    expect(isAllowedNavigation('not a url', APP)).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)', APP)).toBe(false);
    expect(isAllowedNavigation('file:///etc/passwd', APP)).toBe(false);
  });

  it('treats the dev server as the app when that is the configured URL', () => {
    expect(isAllowedNavigation('http://localhost:5173/docs', 'http://localhost:5173')).toBe(true);
    expect(appOrigin('http://localhost:5173/anything')).toBe('http://localhost:5173');
  });
});

describe('isOpenableExternally', () => {
  it('hands only http(s) to the system browser', () => {
    expect(isOpenableExternally('https://example.com/doc.pdf')).toBe(true);
    expect(isOpenableExternally('http://example.com/')).toBe(true);
    expect(isOpenableExternally('file:///etc/passwd')).toBe(false);
    expect(isOpenableExternally('javascript:alert(1)')).toBe(false);
    expect(isOpenableExternally('mailto:someone@example.com')).toBe(false);
    expect(isOpenableExternally('garbage')).toBe(false);
  });
});
