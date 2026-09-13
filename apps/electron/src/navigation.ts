// Pure decisions about where the shell may go, kept free of Electron so
// they can be unit-tested (tests/electron/navigation.spec.ts).

export function appOrigin(appUrl: string): string {
  return new URL(appUrl).origin;
}

/**
 * May the shell's window navigate to `target`? Only within the app's own
 * origin. Everything else — a link in a document, a template author's URL, a
 * phishing page pasted into a comment — opens in the system browser instead
 * (see main.ts).
 *
 * There is no identity-provider exception because there is no identity
 * provider: sign-in is a form served by the app itself, so the allow-list is
 * one origin and stays that way.
 */
export function isAllowedNavigation(target: string, appUrl: string): boolean {
  try {
    return new URL(target).origin === appOrigin(appUrl);
  } catch {
    return false;
  }
}

/** Only http(s) URLs may be handed to the system browser. */
export function isOpenableExternally(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
