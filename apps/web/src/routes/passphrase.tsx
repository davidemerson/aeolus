import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Button, Input } from '@aeolus/shared/ui';

import { api, ApiRequestError } from '../lib/api.js';
import { refreshSession, useSession } from '../lib/session.js';
import { useRouter } from '../router.js';

interface PolicyResponse {
  rule: string;
  suggestion: string;
}

/** The server sends every reason at once; show them all, not just the first. */
function problemsOf(err: ApiRequestError): string[] {
  const problems = err.details.problems;
  if (Array.isArray(problems)) {
    const strings = problems.filter((p): p is string => typeof p === 'string');
    if (strings.length > 0) return strings;
  }
  return [err.message];
}

/**
 * Choose a passphrase.
 *
 * Two audiences share this screen. Someone who just signed in with the
 * credential the installer printed (or one an admin reset) is *required* to be
 * here — every other route answers 403 until they finish. Everyone else
 * arrives from Settings to change one they already have, and gives the current
 * passphrase as well.
 */
export function PassphraseRoute(): JSX.Element {
  const session = useSession();
  const { navigate } = useRouter();
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const forced = session.status === 'authenticated' && session.user.mustSetPassphrase;

  useEffect(() => {
    if (session.status === 'anonymous') navigate('/login', { replace: true });
  }, [session.status, navigate]);

  // The rule text and the suggestion both come from the server, so the screen
  // cannot promise something the policy does not enforce.
  useEffect(() => {
    let live = true;
    void api
      .get<PolicyResponse>('/auth/policy')
      .then((p) => {
        if (live) setPolicy(p);
      })
      .catch(() => {
        /* The form still works; only the hint text is missing. */
      });
    return () => {
      live = false;
    };
  }, []);

  const useSuggestion = useCallback(() => {
    if (!policy) return;
    setNext(policy.suggestion);
    setConfirm(policy.suggestion);
    setProblems([]);
  }, [policy]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    if (next !== confirm) {
      setProblems(['The two passphrases do not match.']);
      return;
    }
    setSaving(true);
    setProblems([]);
    try {
      await api.post('/auth/passphrase', forced ? { next } : { current, next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      await refreshSession();
      navigate('/docs', { replace: true });
    } catch (err) {
      setProblems(
        err instanceof ApiRequestError ? problemsOf(err) : ['That could not be saved. Try again.'],
      );
      setSaving(false);
    }
  }

  if (session.status !== 'authenticated') {
    return <main className="mx-auto max-w-3xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-stretch justify-center px-6 py-12">
      <div className="rounded-card border border-hairline-strong bg-surface p-8 shadow-soft-lift">
        <div className="mb-6">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
            // passphrase
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-body">
            {forced ? 'Choose your passphrase' : 'Change your passphrase'}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-body-2">
            {forced
              ? 'You signed in with a credential someone else generated. Replace it with one only you know.'
              : 'Pick something long. Length is what makes a passphrase strong.'}
          </p>
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => void onSubmit(e)}
          data-testid="passphrase-form"
        >
          {forced ? null : (
            <Input
              label="Current passphrase"
              id="passphrase-current"
              name="current"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              data-testid="passphrase-current"
            />
          )}
          <Input
            label="New passphrase"
            id="passphrase-next"
            name="next"
            type="password"
            autoComplete="new-password"
            required
            hint={policy?.rule}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            data-testid="passphrase-next"
          />
          <Input
            label="Repeat it"
            id="passphrase-confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="passphrase-confirm"
          />

          {policy ? (
            <div className="rounded border border-hairline-strong bg-page px-3 py-2.5">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
                // suggestion
              </div>
              <p
                className="mt-1 break-words font-mono text-[13px] text-body"
                data-testid="passphrase-suggestion"
              >
                {policy.suggestion}
              </p>
              <button
                type="button"
                onClick={useSuggestion}
                data-testid="passphrase-use-suggestion"
                className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted underline-offset-2 transition-colors hover:text-accent-text"
              >
                Use this one
              </button>
            </div>
          ) : null}

          {problems.length > 0 ? (
            <ul className="space-y-1" role="alert" data-testid="passphrase-problems">
              {problems.map((p) => (
                <li key={p} className="font-mono text-[11px] text-accent-text">
                  {p}
                </li>
              ))}
            </ul>
          ) : null}

          <Button
            type="submit"
            disabled={saving || done || next.length === 0 || confirm.length === 0}
            data-testid="passphrase-submit"
            className="w-full !py-2.5"
          >
            {saving ? 'Saving…' : 'Save passphrase'}
          </Button>
        </form>
      </div>
    </main>
  );
}
