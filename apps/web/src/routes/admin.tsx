import { useEffect } from 'react';

import { TopBar } from '../components/TopBar.js';
import { useSession } from '../lib/session.js';
import { Link, useRouter } from '../router.js';

interface AdminCard {
  href: string;
  title: string;
  body: string;
  testid: string;
}

const CARDS: AdminCard[] = [
  {
    href: '/admin/users',
    title: 'Users',
    body: 'Create accounts, issue a new passphrase, promote or demote admins, disable, or hard-delete. There is no self-service signup: an administrator adds every user.',
    testid: 'admin-card-users',
  },
  {
    href: '/admin/templates',
    title: 'Templates',
    body: 'Create branded templates, edit their source, and toggle published status. Only published templates appear on the user-facing documents page.',
    testid: 'admin-card-templates',
  },
  {
    href: '/admin/diagnostics',
    title: 'Diagnostics',
    body: 'Run a smoke compile end-to-end against a known-good LaTeX template, plus snapshot of the queue and recent compile statuses. Use this to localize "compile not working" reports.',
    testid: 'admin-card-diagnostics',
  },
  {
    href: '/admin/audit',
    title: 'Audit log',
    body: 'Last 30 days of authentication and major mutation events: logins, doc / template / user CRUD. Filter by action prefix or actor.',
    testid: 'admin-card-audit',
  },
];

export function AdminRoute() {
  const session = useSession();
  const { navigate } = useRouter();

  useEffect(() => {
    if (session.status === 'anonymous') {
      navigate('/login', { replace: true });
    } else if (session.status === 'authenticated' && !session.user.isAdmin) {
      navigate('/docs', { replace: true });
    }
  }, [session, navigate]);

  if (session.status !== 'authenticated' || !session.user.isAdmin) {
    return <main className="mx-auto max-w-4xl px-6 py-20 text-sm text-muted">Loading…</main>;
  }

  return (
    <>
      <TopBar user={session.user} />
      <main className="mx-auto max-w-5xl px-8 py-12">
        <div className="mb-10 border-b border-hairline pb-6">
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted">
            // operator
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-body">Admin</h1>
          <p className="mt-2 font-mono text-[12px] text-muted">signed in as {session.user.email}</p>
        </div>
        <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-hairline-strong bg-hairline-strong sm:grid-cols-2">
          {CARDS.map((c) => (
            <li key={c.href} className="bg-surface">
              <Link
                to={c.href}
                className="group block h-full p-6 transition-colors hover:bg-page"
                data-testid={c.testid}
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-base font-semibold text-body">{c.title}</div>
                  <span className="font-mono text-[12px] tracking-wider text-muted transition-colors group-hover:text-accent-text">
                    →
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-body-2">{c.body}</p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
