import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { setPassphraseSetupHandler, setUnauthenticatedHandler } from './lib/api.js';
import { clearSession } from './lib/session.js';
import './styles/globals.css';

// A 401 from any /api call means the session is gone — drop the user
// at /login. Without this, every 401-prone caller (compile, AI panel,
// asset upload, …) would surface the API's "Not signed in" body
// inside its own UI ("Compile failed — Not signed in"), which is
// both confusing and wrong. Skips the redirect when the user is
// already on a public route so /login's own /me probe doesn't loop.
//
// /guide is public for the same reason /login is, and it matters more than it
// looks: the guide is linked FROM the login page for someone who cannot get
// in, and the session probe 401s for exactly that person. Without this the
// link bounced straight back to /login — the affordance existed and did
// nothing, which is worse than not having it.
const PUBLIC_PREFIXES = ['/login', '/guide'];
let redirecting = false;
setUnauthenticatedHandler(() => {
  if (redirecting) return;
  clearSession();
  const path = window.location.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  if (!isPublic) {
    redirecting = true;
    window.location.assign('/login');
  }
});

// A 403 passphrase_setup_required means the account is still on the credential
// the installer printed. Anything the SPA asks for will be refused until that
// is replaced, so go and do it — from any route except the setup screen itself
// (which would loop) and the guide (which explains the screen).
const SETUP_PREFIXES = ['/passphrase', '/guide'];
setPassphraseSetupHandler(() => {
  if (redirecting) return;
  const path = window.location.pathname;
  if (SETUP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;
  redirecting = true;
  window.location.assign('/passphrase');
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
