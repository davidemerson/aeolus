import { useCallback, useEffect, useState } from 'react';

import { Button, Input, toastStore } from '@aeolus/shared/ui';

import { TopBar } from '../components/TopBar.js';
import { api, ApiRequestError } from '../lib/api.js';
import { readEditorTheme, writeEditorTheme, type EditorThemeName } from '../lib/editor-theme.js';
import { useAppThemeContext } from '../lib/appearance.js';
import { refreshSession, useSession } from '../lib/session.js';
import { useRouter } from '../router.js';

export function SettingsRoute(): JSX.Element {
  const session = useSession();
  const { navigate } = useRouter();
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [editorTheme, setEditorTheme] = useState<EditorThemeName>(readEditorTheme);
  const { theme: appTheme, setTheme: setAppTheme } = useAppThemeContext();

  const pickEditorTheme = useCallback((next: EditorThemeName): void => {
    setEditorTheme(next);
    // An open editor tab listens for this key and re-themes live.
    writeEditorTheme(next);
    toastStore.push({ kind: 'success', message: 'Editor theme saved' });
  }, []);

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    }
  }, [session.status, navigate]);

  const sessionUserName = session.status === 'authenticated' ? (session.user.name ?? '') : '';
  useEffect(() => {
    if (session.status !== 'authenticated') return;
    setName(sessionUserName);
  }, [session.status, sessionUserName]);

  const saveName = useCallback(async () => {
    if (savingName || session.status !== 'authenticated') return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setSavingName(true);
    try {
      await api.patch('/me', { name: trimmed });
      await refreshSession();
      toastStore.push({ kind: 'success', message: 'Name updated' });
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to save',
      });
    } finally {
      setSavingName(false);
    }
  }, [name, savingName, session.status]);

  if (session.status !== 'authenticated') {
    return <main className="mx-auto max-w-3xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar user={session.user} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-8">
        <h1 className="mb-6 text-xl font-semibold text-body">Settings</h1>

        <section className="mb-6 rounded-card border border-hairline-strong bg-surface shadow-card">
          <div className="border-b border-hairline-strong px-5 py-3">
            <h2 className="text-sm font-semibold text-body">Profile</h2>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div>
              <label
                htmlFor="settings-email"
                className="mb-1 block text-xs font-medium text-body-2"
              >
                Email
              </label>
              <Input
                id="settings-email"
                value={session.user.email}
                disabled
                readOnly
                data-testid="settings-email"
              />
              <p className="mt-1 text-xs text-muted">
                Email is the username. An administrator changes it.
              </p>
            </div>
            <div>
              <label htmlFor="settings-name" className="mb-1 block text-xs font-medium text-body-2">
                Display name
              </label>
              <div className="flex gap-2">
                <Input
                  id="settings-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="settings-name"
                  maxLength={200}
                />
                <Button
                  variant="primary"
                  disabled={
                    savingName ||
                    name.trim().length === 0 ||
                    name.trim() === (session.user.name ?? '')
                  }
                  onClick={() => void saveName()}
                  data-testid="settings-save-name"
                >
                  {savingName ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section
          className="mb-6 rounded-card border border-hairline-strong bg-surface shadow-card"
          data-testid="security-section"
        >
          <div className="border-b border-hairline-strong px-5 py-3">
            <h2 className="text-sm font-semibold text-body">Security</h2>
          </div>
          <div className="px-5 py-4">
            <p className="text-xs leading-relaxed text-muted">
              Your passphrase is the only credential on this instance. Changing it signs nobody out,
              including you.
            </p>
            <Button
              variant="ghost"
              className="mt-3"
              onClick={() => navigate('/passphrase')}
              data-testid="settings-change-passphrase"
            >
              Change passphrase
            </Button>
          </div>
        </section>

        {/* Appearance — the APP theme. Documented here because the header
            control is an unlabelled mark, and a settings page is where someone
            goes looking for a preference they half-remember. */}
        <section
          className="rounded-card border border-hairline-strong bg-surface shadow-card"
          data-testid="appearance-section"
        >
          <div className="border-b border-hairline-strong px-5 py-3">
            <h2 className="text-sm font-semibold text-body">Appearance</h2>
            <p className="mt-1 text-xs text-muted">
              Light, dark, or follow your operating system. Applies to the whole app and is
              remembered on every device you sign in from. The same control is the half-disc mark in
              the header.
            </p>
          </div>
          <div className="flex gap-2 px-5 py-4">
            {(['auto', 'light', 'dark'] as const).map((t) => (
              <Button
                key={t}
                variant={appTheme === t ? 'primary' : 'ghost'}
                onClick={() => setAppTheme(t)}
                data-testid={`appearance-${t}`}
                aria-pressed={appTheme === t}
              >
                {t === 'auto' ? 'Follow system' : t === 'light' ? 'Light' : 'Dark'}
              </Button>
            ))}
          </div>
        </section>

        <section
          className="rounded-card border border-hairline-strong bg-surface shadow-card"
          data-testid="editor-theme-section"
        >
          <div className="border-b border-hairline-strong px-5 py-3">
            <h2 className="text-sm font-semibold text-body">Editor theme</h2>
            <p className="mt-1 text-xs text-muted">
              The document editor uses the Solarized palette. By default it follows the app&rsquo;s
              appearance; pin it if you want a dark editor beside a light UI, or the reverse. Saved
              to this browser.
            </p>
          </div>
          {/* No ☾ / ☀ glyphs: the self-hosted faces do not carry them, so they
              fall through to OS fallback and tofu on a font-poor host. The
              labels say it in words instead. */}
          <div className="flex flex-wrap gap-2 px-5 py-4">
            {(
              [
                ['auto', 'Follow app'],
                ['solarized-dark', 'Solarized dark'],
                ['solarized-light', 'Solarized light'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={editorTheme === value ? 'primary' : 'ghost'}
                onClick={() => pickEditorTheme(value)}
                data-testid={`editor-theme-${value === 'auto' ? 'auto' : value.replace('solarized-', '')}`}
                aria-pressed={editorTheme === value}
              >
                {label}
              </Button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
