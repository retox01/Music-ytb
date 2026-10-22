/**
 * Small standalone "update available" window: shows real download progress
 * and installs automatically, replacing the old flow (a native dialog whose
 * "Download" button just opened the GitHub releases page in a browser for
 * the user to download and run by hand). Same "write a tiny temp HTML +
 * preload pair, no bundler entry needed" technique already used by
 * src/plugins/skip-ai-music's picker dialogs and src/plugins/rainmeter-widget
 * — reused here for the same reason: no Vite page to register.
 *
 * shortcut: UI text is hardcoded in French rather than wired through the
 * i18n system (`t()`), which only runs inside the bundled renderer this
 * page isn't part of. Fine for a small personal/friends build; route it
 * through i18n (and the preload's own context) if this is ever meant for a
 * general audience.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

export type UpdaterState =
  | {
      phase: 'downloading';
      percent: number;
      bytesPerSecond: number;
      version?: string;
    }
  | { phase: 'ready'; version?: string }
  | { phase: 'error'; message: string };

const WINDOW_SIZE = { width: 380, height: 210 };

const UPDATER_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title></title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: transparent;
    font-family: 'Segoe UI', Roboto, sans-serif;
    color: rgba(255, 255, 255, 0.95);
    -webkit-user-select: none;
  }
  body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    padding: 20px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    background:
      radial-gradient(circle at 20% 0%, rgba(120, 90, 200, 0.45), transparent 60%),
      rgba(15, 15, 18, 0.95);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    -webkit-app-region: drag;
  }
  h1 { margin: 0; font-size: 15px; font-weight: 700; }
  #sub { margin: 0; font-size: 12px; opacity: 0.7; }
  #bar-track {
    height: 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.12);
    overflow: hidden;
  }
  #bar-fill {
    height: 100%;
    width: 0%;
    border-radius: 4px;
    background: linear-gradient(90deg, #8a6bff, #c38bff);
    transition: width 0.3s ease;
  }
  #status { font-size: 12px; opacity: 0.75; }
  #actions {
    margin-top: auto;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    -webkit-app-region: no-drag;
  }
  button {
    border: none;
    border-radius: 8px;
    padding: 7px 14px;
    font-size: 12px;
    cursor: pointer;
    color: #fff;
  }
  #btn-later { background: transparent; opacity: 0.6; }
  #btn-later:hover { opacity: 1; }
  #btn-install { background: #8a6bff; font-weight: 600; }
  #btn-install:hover { background: #9c7fff; }
  #error { color: #ff8a8a; font-size: 12px; display: none; }
</style>
</head>
<body>
  <h1 id="title">Mise à jour disponible</h1>
  <p id="sub">Téléchargement en cours…</p>
  <div id="bar-track"><div id="bar-fill"></div></div>
  <p id="status">—</p>
  <p id="error"></p>
  <div id="actions">
    <button type="button" id="btn-later">Plus tard</button>
    <button type="button" id="btn-install" style="display:none">Redémarrer et installer</button>
  </div>
  <script>
    let readyCountdown = null;

    function clearCountdown() {
      if (readyCountdown) clearInterval(readyCountdown);
      readyCountdown = null;
    }

    window.updaterWindow.onUpdate((state) => {
      const sub = document.getElementById('sub');
      const status = document.getElementById('status');
      const fill = document.getElementById('bar-fill');
      const installBtn = document.getElementById('btn-install');
      const errorEl = document.getElementById('error');

      if (state.phase === 'downloading') {
        clearCountdown();
        errorEl.style.display = 'none';
        installBtn.style.display = 'none';
        sub.textContent = 'Téléchargement en cours…';
        fill.style.width = Math.round(state.percent) + '%';
        const speed = (state.bytesPerSecond / 1024 / 1024).toFixed(1);
        status.textContent = Math.round(state.percent) + ' % — ' + speed + ' Mo/s';
      } else if (state.phase === 'ready') {
        errorEl.style.display = 'none';
        installBtn.style.display = '';
        fill.style.width = '100%';
        sub.textContent = 'Prêt à installer.';
        let remaining = 10;
        status.textContent = 'Redémarrage automatique dans ' + remaining + ' s…';
        clearCountdown();
        readyCountdown = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearCountdown();
            window.updaterWindow.installNow();
            return;
          }
          status.textContent = 'Redémarrage automatique dans ' + remaining + ' s…';
        }, 1000);
      } else if (state.phase === 'error') {
        clearCountdown();
        sub.textContent = 'La mise à jour a échoué.';
        status.textContent = '';
        errorEl.style.display = '';
        errorEl.textContent = state.message;
      }
    });

    document.getElementById('btn-install').addEventListener('click', () => {
      clearCountdown();
      window.updaterWindow.installNow();
    });
    document.getElementById('btn-later').addEventListener('click', () => {
      clearCountdown();
      window.updaterWindow.dismiss();
    });
  </script>
</body>
</html>`;

let htmlFilePath: string | null = null;
async function getHtmlPath(): Promise<string> {
  htmlFilePath ??= path.join(app.getPath('temp'), 'glassy-updater.html');
  await writeFile(htmlFilePath, UPDATER_HTML, 'utf8');
  return htmlFilePath;
}

let preloadFilePath: string | null = null;
async function getPreloadPath(): Promise<string> {
  if (preloadFilePath) return preloadFilePath;
  const file = path.join(app.getPath('temp'), 'glassy-updater-preload.js');
  await writeFile(
    file,
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('updaterWindow', {
  onUpdate: (cb) => ipcRenderer.on('glassy-updater:state', (_e, state) => cb(state)),
  installNow: () => ipcRenderer.send('glassy-updater:install-now'),
  dismiss: () => ipcRenderer.send('glassy-updater:dismiss'),
});
`,
    'utf8',
  );
  preloadFilePath = file;
  return file;
}

let updaterWin: BrowserWindow | null = null;
let handlersBound = false;

/**
 * Opens the update window (no-op if already open) and wires its two actions.
 * `onInstallNow` is called when the user clicks "Redémarrer et installer" (or
 * the 10s auto-countdown in 'ready' phase elapses) — call
 * `autoUpdater.quitAndInstall()` from it. `onDismiss` fires on "Plus tard".
 */
export async function openUpdaterWindow(
  parent: BrowserWindow | null,
  onInstallNow: () => void,
  onDismiss: () => void,
): Promise<void> {
  if (!handlersBound) {
    handlersBound = true;
    ipcMain.on('glassy-updater:install-now', () => onInstallNow());
    ipcMain.on('glassy-updater:dismiss', () => {
      onDismiss();
      closeUpdaterWindow();
    });
  }

  if (updaterWin && !updaterWin.isDestroyed()) return;

  const win = new BrowserWindow({
    ...WINDOW_SIZE,
    parent: parent ?? undefined,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundColor: '#0f0f12',
    webPreferences: {
      preload: await getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    updaterWin = null;
  });

  await win.loadFile(await getHtmlPath());
  updaterWin = win;
}

export function pushUpdaterState(state: UpdaterState): void {
  if (updaterWin && !updaterWin.isDestroyed()) {
    updaterWin.webContents.send('glassy-updater:state', state);
  }
}

export function closeUpdaterWindow(): void {
  if (updaterWin && !updaterWin.isDestroyed()) updaterWin.close();
  updaterWin = null;
}
