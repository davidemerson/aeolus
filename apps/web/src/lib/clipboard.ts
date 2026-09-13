// Copy text to the clipboard without ever throwing.
//
// `navigator.clipboard` only exists on secure origins (https, localhost). On a
// plain-http deployment — which a self-hosted install on a LAN may well be —
// the property is undefined, and `navigator.clipboard.writeText(...)` is a
// synchronous TypeError before any promise exists. Three panels used to call
// it directly; one caught the failure, one turned it into an unhandled
// rejection, and one threw from a click handler.
//
// The fallback is the pre-clipboard-API recipe: a temporary textarea,
// select(), execCommand('copy'). It is deprecated but still works in every
// browser this app ships to, and it is the only path available on http.
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or the document is not focused. The legacy path
      // would fail for the same reason, so report it rather than try twice.
      return false;
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  // Off-screen and fixed so appending it never scrolls the page.
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
