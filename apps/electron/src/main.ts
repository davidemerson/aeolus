// Aeolus — a collaborative LaTeX and Typst editor you host yourself.
// Copyright (C) 2026 David Emerson
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
// for more details. You should have received a copy of it along with this
// program; if not, see <https://www.gnu.org/licenses/>.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';

import { isAllowedNavigation, isOpenableExternally } from './navigation.js';

// A packaged shell points at the deployed app; a development run points at
// the Vite dev server. AEOLUS_APP_URL overrides both. Before 2026-09-13 the
// packaged default was the dev server, so an installer with no
// environment opened a connection-refused page.
const DEFAULT_APP_URL = app.isPackaged ? 'http://localhost:8080' : 'http://localhost:5173';
const APP_URL = process.env['AEOLUS_APP_URL'] ?? DEFAULT_APP_URL;
const UPDATES_HOST = process.env['AEOLUS_UPDATES_HOST'] ?? '';

let mainWindow: BrowserWindow | null = null;

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ source: 'electron', event, ...fields })}\n`);
}

// The updater is dormant (ADR 0006, unsigned pilot): electron-builder.yml
// sets `publish: null` and no build sets AEOLUS_UPDATES_HOST. When a host
// is configured this wires the generic provider at it so the code path
// is complete rather than half-present.
function initAutoUpdater(): void {
  if (!app.isPackaged || !UPDATES_HOST) {
    log('auto-update disabled', { reason: app.isPackaged ? 'no updates host' : 'not packaged' });
    return;
  }

  autoUpdater.setFeedURL({ provider: 'generic', url: `https://${UPDATES_HOST}/` });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log('update available', { version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update ready',
        message: `Version ${info.version} has been downloaded and will be installed when Aeolus restarts.`,
        buttons: ['Restart now', 'Later'],
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
      })
      .catch((err: unknown) => {
        log('update dialog failed', { error: String(err) });
      });
  });

  autoUpdater.on('error', (err) => {
    log('auto-update error', { error: err.message });
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
    log('auto-update check failed', { error: String(err) });
  });
}

function openExternally(target: string): void {
  if (!isOpenableExternally(target)) {
    log('blocked navigation', { target });
    return;
  }
  shell.openExternal(target).catch((err: unknown) => {
    log('openExternal failed', { target, error: String(err) });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(import.meta.dirname, 'preload.js'),
    },
  });

  // The shell shows Aeolus and the identity provider, nothing else. A
  // window.open() or a top-frame navigation anywhere else goes to the
  // system browser; the shell stays on the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url, APP_URL)) return { action: 'allow' };
    openExternally(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, APP_URL)) return;
    event.preventDefault();
    openExternally(url);
  });

  mainWindow.loadURL(APP_URL).catch((err: unknown) => {
    log('loadURL failed', { url: APP_URL, error: String(err) });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // CI hook: tests/electron/boot.spec.ts launches the packaged binary
  // with --headless-test and expects it to exit 0 once the page loaded
  // (1 on a load failure). Harmless in a user's hands — it is a flag,
  // not a default.
  if (process.argv.includes('--headless-test')) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => app.exit(0), 2000);
    });
    mainWindow.webContents.on('did-fail-load', () => {
      app.exit(1);
    });
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';

  const viewItems: Electron.MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    // DevTools only in a development run; a packaged shell has no
    // reason to offer the user the inspector.
    ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewItems },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          // The in-app guide is the documentation; the repository is not
          // something a user should be sent to.
          label: 'Aeolus guide',
          click: () => {
            mainWindow?.loadURL(`${APP_URL}/guide`).catch((err: unknown) => {
              log('loadURL failed', { url: `${APP_URL}/guide`, error: String(err) });
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The renderer asks for these over IPC; preload exposes them as
// window.aeolus. `npm_package_version` only exists under an npm script
// runner, so the old preload reported 0.0.0 in every packaged build.
ipcMain.on('aeolus:about', (event) => {
  event.returnValue = { version: app.getVersion(), platform: process.platform };
});

app
  .whenReady()
  .then(() => {
    buildMenu();
    createWindow();
    initAutoUpdater();
  })
  .catch((err: unknown) => {
    log('startup failed', { error: String(err) });
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
