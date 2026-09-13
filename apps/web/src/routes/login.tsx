import { useEffect, useState, type FormEvent } from 'react';

import { Button, Input } from '@aeolus/shared/ui';

import { api, ApiRequestError } from '../lib/api.js';
import { refreshSession, useSession } from '../lib/session.js';
import { Link, useRouter } from '../router.js';

interface LoginResponse {
  user: { id: string; email: string; name: string | null; is_admin: boolean };
  must_set_passphrase: boolean;
}

/**
 * Sign-in. Aeolus authenticates people locally against a passphrase it stores
 * itself — there is no identity provider to stand up, which is the point of a
 * self-hosted install. The first account and its credential are printed to the
 * server log at first launch; see the README.
 */
export function LoginRoute() {
  const { navigate } = useRouter();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (session.status === 'authenticated') {
      navigate(session.user.mustSetPassphrase ? '/passphrase' : '/docs', { replace: true });
    }
  }, [session, navigate]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<LoginResponse>('/auth/login', {
        email: email.trim(),
        passphrase,
      });
      // Drop the plaintext from component state the moment it is spent.
      setPassphrase('');
      await refreshSession();
      navigate(result.must_set_passphrase ? '/passphrase' : '/docs', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Sign-in failed. Try again in a moment.',
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-stretch justify-center px-6 py-12">
      <div className="mb-10 flex items-center gap-3">
        <img src="/aeolus-mark.svg" alt="" aria-hidden="true" className="h-9 w-9" />
        <span className="text-lg font-semibold leading-9 tracking-tight text-body">Aeolus</span>
      </div>

      <div className="rounded-card border border-hairline-strong bg-surface p-8 shadow-soft-lift">
        <div className="mb-6">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
            // sign-in
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-body">Sign in</h1>
          <p className="mt-3 text-sm leading-relaxed text-body-2">
            Use the email and passphrase for this instance. Accounts are created by an
            administrator.
          </p>
        </div>

        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} data-testid="login-form">
          <Input
            label="Email"
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="login-email"
          />
          <Input
            label="Passphrase"
            id="login-passphrase"
            name="passphrase"
            type="password"
            autoComplete="current-password"
            required
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            data-testid="login-passphrase"
          />
          {error ? (
            <p
              className="font-mono text-[11px] text-accent-text"
              role="alert"
              data-testid="login-error"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={submitting || email.trim().length === 0 || passphrase.length === 0}
            data-testid="login-submit"
            className="w-full !py-2.5"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 text-xs leading-relaxed text-muted">
          Lost your passphrase? An administrator can issue a new one from Admin → Users. There is no
          emailed reset — a self-hosted instance has no mail server to rely on.
        </p>
      </div>

      {/* The guide affordance has to be on every page, and this page most of
          all — someone who cannot get in is exactly the person looking for an
          explanation. This route renders no TopBar by design, so it carries its
          own quiet link rather than growing a full header. */}
      <div className="mt-6 text-center">
        <Link
          to="/guide"
          data-testid="login-guide"
          className="font-mono text-[11px] uppercase tracking-widest text-muted no-underline transition-colors hover:text-accent-text"
        >
          Read the guide →
        </Link>
      </div>
    </main>
  );
}
