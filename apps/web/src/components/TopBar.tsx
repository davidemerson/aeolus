import { useCallback, useState } from 'react';

import { Avatar } from '@aeolus/shared/ui';

import { Link } from '../router.js';
import { api, type Me } from '../lib/api.js';
import { useAppThemeContext } from '../lib/appearance.js';
import { AppearanceToggle } from './AppearanceToggle.js';

interface NavLinkProps {
  to: string;
  label: string;
  testid?: string;
}

function NavLink({ to, label, testid }: NavLinkProps) {
  return (
    <Link
      to={to}
      data-testid={testid}
      className="rounded-badge px-2 py-1 font-mono text-[12px] uppercase tracking-wider text-muted transition-colors hover:bg-fill-hover hover:text-body"
    >
      {label}
    </Link>
  );
}

export function TopBar({ user }: { user: Me['user'] | null }) {
  const [signingOut, setSigningOut] = useState(false);
  const { theme, cycle } = useAppThemeContext();
  // Display name, not the raw email:
  // gives us `name`; fall back to the email local-part for rows
  // provisioned before the name claim landed.
  const displayName = user ? (user.name ?? user.email.split('@')[0]) : '';

  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      // The endpoint is idempotent (204 even without a session
      // cookie) and clears the cookie server-side; we still
      // redirect to /login regardless of network outcome so the
      // UI never gets stranded on a logged-in shell after the
      // user clicks "Sign out."
      await api.delete('/me/session');
    } catch {
      /* swallow — we still redirect below */
    } finally {
      // Hard reload to drop session-derived module state
      // (useSession store, any Yjs providers in flight) without
      // having to plumb an explicit reset through every consumer.
      window.location.assign('/login');
    }
  }, [signingOut]);

  return (
    <header className="border-b border-hairline-strong bg-surface print:hidden">
      <div className="flex items-center justify-between px-8 py-3">
        <Link to="/docs" className="group flex items-center gap-3 text-lg text-body">
          <img src="/aeolus-mark.svg" alt="" aria-hidden="true" className="h-7 w-7 shrink-0" />
          <span className="font-semibold tracking-tight text-body">Aeolus</span>
        </Link>
        <nav className="flex items-center gap-1">
          <NavLink to="/docs" label="Workspace" />
          {user?.isAdmin ? <NavLink to="/admin" label="Admin" testid="topbar-admin" /> : null}
          {user ? <NavLink to="/tokens" label="Tokens" testid="topbar-tokens" /> : null}
          {user ? <NavLink to="/settings" label="Settings" testid="topbar-settings" /> : null}
          {/* The guide affordance is deliberately unconditional and in the
              header on every page — never
              behind the avatar menu, and present while signed out, because a
              lost user is often looking at the login page. */}
          <NavLink to="/guide" label="Guide" testid="topbar-guide" />
          <AppearanceToggle theme={theme} onCycle={cycle} className="ml-1" />
          {user ? (
            <>
              <span className="mx-3 h-4 w-px bg-hairline-strong" aria-hidden />
              {/* Display name + 28px avatar (standard 2026-07-02);
                  the raw email lives in the title tooltip. */}
              <span
                className="font-mono text-[11px] tracking-wide text-muted"
                data-testid="topbar-user"
                title={user.email}
              >
                {displayName}
              </span>
              <Avatar name={displayName} size="sm" className="ml-2" />
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                data-testid="topbar-signout"
                className="ml-2 rounded-badge px-2 py-1 font-mono text-[12px] uppercase tracking-wider text-muted transition-colors hover:bg-fill-hover hover:text-accent-text disabled:opacity-60"
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
