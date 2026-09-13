import { lazy, Suspense, useEffect } from 'react';
import { AppThemeProvider } from './lib/appearance.js';

import { ToastHost } from '@aeolus/shared/ui';

import { RouterProvider, Routes, type RouteDef, useRouter } from './router.js';
import { useSession } from './lib/session.js';
import { VersionFooter } from './components/VersionFooter.js';
// Eager: routes that almost everyone hits on the first load.
import { LoginRoute } from './routes/login.js';
import { PassphraseRoute } from './routes/passphrase.js';
import { DocsListRoute } from './routes/docs-list.js';
import { NotFoundRoute } from './routes/not-found.js';

// Lazy: heavier surfaces (editor pulls in CodeMirror + Yjs +
// y-websocket; admin routes are only used by admins). These ship
// in their own chunks so a /login or /docs visit doesn't pay for
// them.
const DocEditorRoute = lazy(() =>
  import('./routes/doc-editor.js').then((m) => ({ default: m.DocEditorRoute })),
);
const AdminRoute = lazy(() => import('./routes/admin.js').then((m) => ({ default: m.AdminRoute })));
const AdminDiagnosticsRoute = lazy(() =>
  import('./routes/admin-diagnostics.js').then((m) => ({
    default: m.AdminDiagnosticsRoute,
  })),
);
const AdminTemplatesRoute = lazy(() =>
  import('./routes/admin-templates.js').then((m) => ({
    default: m.AdminTemplatesRoute,
  })),
);
const AdminTemplateEditorRoute = lazy(() =>
  import('./routes/admin-template-editor.js').then((m) => ({
    default: m.AdminTemplateEditorRoute,
  })),
);
const SettingsRoute = lazy(() =>
  import('./routes/settings.js').then((m) => ({ default: m.SettingsRoute })),
);
const TokensRoute = lazy(() =>
  import('./routes/tokens.js').then((m) => ({ default: m.TokensRoute })),
);
const AdminUsersRoute = lazy(() =>
  import('./routes/admin-users.js').then((m) => ({ default: m.AdminUsersRoute })),
);
const AdminAuditRoute = lazy(() =>
  import('./routes/admin-audit.js').then((m) => ({ default: m.AdminAuditRoute })),
);
// Lazy: the guide is a lot of prose and a screenshot manifest, and nobody hits
// it on the hot path. Its own chunk keeps it off the /docs and /login payload.
const GuideRoute = lazy(() => import('./routes/guide.js').then((m) => ({ default: m.GuideRoute })));

const routes: readonly RouteDef[] = [
  { path: '/', render: () => <HomeRedirect /> },
  { path: '/login', render: () => <LoginRoute /> },
  { path: '/passphrase', render: () => <PassphraseRoute /> },
  { path: '/docs', render: () => <DocsListRoute /> },
  { path: '/docs/:id', render: ({ id }) => <DocEditorRoute id={id} /> },
  { path: '/settings', render: () => <SettingsRoute /> },
  { path: '/tokens', render: () => <TokensRoute /> },
  // The guide is readable signed out: a lost user is often on /login, and the
  // header link is present there too.
  { path: '/guide', render: () => <GuideRoute /> },
  { path: '/guide/:section', render: ({ section }) => <GuideRoute section={section} /> },
  { path: '/admin', render: () => <AdminRoute /> },
  { path: '/admin/diagnostics', render: () => <AdminDiagnosticsRoute /> },
  { path: '/admin/templates', render: () => <AdminTemplatesRoute /> },
  { path: '/admin/users', render: () => <AdminUsersRoute /> },
  { path: '/admin/audit', render: () => <AdminAuditRoute /> },
  {
    path: '/admin/templates/:id',
    render: ({ id }) => <AdminTemplateEditorRoute id={id} />,
  },
];

export function HomeRedirect() {
  const { navigate } = useRouter();
  useEffect(() => {
    navigate('/docs', { replace: true });
  }, [navigate]);
  return null;
}

/**
 * A user still on a generated credential can reach the SPA but nothing in it:
 * the api answers 403 passphrase_setup_required everywhere except the setup
 * routes. Rather than let that surface as a broken page, send them to
 * /passphrase from wherever they land. /guide stays reachable — it is the one
 * place that explains what is being asked of them.
 */
const SETUP_ALLOWED_PREFIXES = ['/passphrase', '/guide'];

function PassphraseGate() {
  const session = useSession();
  const { path, navigate } = useRouter();
  const mustSet = session.status === 'authenticated' && session.user.mustSetPassphrase;
  const allowed = SETUP_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  useEffect(() => {
    if (mustSet && !allowed) navigate('/passphrase', { replace: true });
  }, [mustSet, allowed, navigate]);
  return null;
}

function AppFrame() {
  const { path } = useRouter();
  // The doc editor is an immersive, exactly-viewport surface
  // (h-screen, overflow-hidden panes) — appending the footer there
  // would put a body scrollbar under the editor, so it opts out of
  // the version stamp. Every other page carries it.
  const isEditor = /^\/docs\/[^/]+$/.test(path);
  return (
    <div className="flex min-h-full flex-col bg-page">
      <PassphraseGate />
      <div className="flex flex-1 flex-col">
        <Suspense
          fallback={
            <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted">
              Loading…
            </div>
          }
        >
          <Routes routes={routes} fallback={<NotFoundRoute />} />
        </Suspense>
      </div>
      {isEditor ? null : <VersionFooter />}
      <ToastHost />
    </div>
  );
}

export function App() {
  return (
    // AppThemeProvider wraps everything so the header control and the
    // CodeMirror editor share ONE theme instance — see lib/appearance.tsx.
    <AppThemeProvider>
      <RouterProvider>
        {/* Flex column pinned to the viewport height so the version
          footer sits at the bottom even on short pages (minor-app
          layout recipe). Routes render inside the stretching
          middle region. */}
        <AppFrame />
      </RouterProvider>
    </AppThemeProvider>
  );
}
