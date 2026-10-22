/**
 * Standalone "Importer une playlist Spotify" window. Same "temp HTML + tiny
 * preload, no bundler entry" technique already used by
 * src/plugins/skip-ai-music, src/plugins/rainmeter-widget and
 * src/providers/updater-window.ts.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

export type ImportLogEntry = {
  ok: boolean;
  title: string;
  artist: string;
};

export type ImportState =
  | { phase: 'idle' }
  | { phase: 'fetching' }
  | { phase: 'matching'; done: number; total: number; log: ImportLogEntry[] }
  | { phase: 'done'; found: number; total: number; log: ImportLogEntry[] }
  | { phase: 'error'; message: string };

const WINDOW_SIZE = { width: 420, height: 480 };

const IMPORT_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>Importer une playlist Spotify</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: #121214;
    font-family: 'Segoe UI', Roboto, sans-serif;
    color: rgba(255, 255, 255, 0.95);
  }
  body { display: flex; flex-direction: column; gap: 12px; padding: 16px; height: 100%; }
  h1 { margin: 0; font-size: 15px; }
  p.hint { margin: 0; font-size: 11px; opacity: 0.6; line-height: 1.5; }
  #url {
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: #1b1b1e;
    color: inherit;
    font-size: 13px;
  }
  #import-btn {
    align-self: flex-start;
    border: none;
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    background: #1DB954;
    color: #0b0b0c;
    cursor: pointer;
  }
  #import-btn:disabled { opacity: 0.5; cursor: default; }
  #progress-text { font-size: 12px; opacity: 0.8; }
  #log {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    border-radius: 8px;
    background: #1b1b1e;
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.7;
  }
  .ok { color: #7ee787; }
  .ko { color: #ff8a8a; }
  #error { color: #ff8a8a; font-size: 12px; display: none; }
</style>
</head>
<body>
  <h1>Importer une playlist Spotify</h1>
  <p class="hint">Colle le lien de partage d'une playlist Spotify <b>publique</b> (clic droit sur la playlist dans Spotify → Partager → Copier le lien). Les morceaux trouvés sont ajoutés à la file d'attente — utilise ensuite "Enregistrer dans une playlist" dans YouTube Music pour la garder.</p>
  <input type="text" id="url" placeholder="https://open.spotify.com/playlist/..." />
  <button type="button" id="import-btn">Importer</button>
  <p id="progress-text"></p>
  <p id="error"></p>
  <div id="log"></div>
  <script>
    const urlInput = document.getElementById('url');
    const btn = document.getElementById('import-btn');
    const progressText = document.getElementById('progress-text');
    const errorEl = document.getElementById('error');
    const logEl = document.getElementById('log');

    function renderLog(entries) {
      logEl.innerHTML = entries.map((e) =>
        '<div class="' + (e.ok ? 'ok' : 'ko') + '">' + (e.ok ? '✓' : '✗') + ' ' +
        e.title.replace(/</g, '&lt;') + ' — ' + e.artist.replace(/</g, '&lt;') + '</div>'
      ).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }

    window.spotifyImport.onState((state) => {
      errorEl.style.display = 'none';
      if (state.phase === 'idle') {
        btn.disabled = false;
        progressText.textContent = '';
      } else if (state.phase === 'fetching') {
        btn.disabled = true;
        progressText.textContent = 'Lecture de la playlist Spotify…';
        logEl.innerHTML = '';
      } else if (state.phase === 'matching') {
        btn.disabled = true;
        progressText.textContent = 'Recherche sur YouTube Music… ' + state.done + ' / ' + state.total;
        renderLog(state.log);
      } else if (state.phase === 'done') {
        btn.disabled = false;
        progressText.textContent = state.found + ' / ' + state.total + ' morceaux ajoutés à la file d\\'attente.';
        renderLog(state.log);
      } else if (state.phase === 'error') {
        btn.disabled = false;
        progressText.textContent = '';
        errorEl.style.display = '';
        errorEl.textContent = state.message;
      }
    });

    btn.addEventListener('click', () => {
      const url = urlInput.value.trim();
      if (url) window.spotifyImport.startImport(url);
    });
  </script>
</body>
</html>`;

let htmlFilePath: string | null = null;
async function getHtmlPath(): Promise<string> {
  htmlFilePath ??= path.join(app.getPath('temp'), 'glassy-spotify-import.html');
  await writeFile(htmlFilePath, IMPORT_HTML, 'utf8');
  return htmlFilePath;
}

let preloadFilePath: string | null = null;
async function getPreloadPath(): Promise<string> {
  if (preloadFilePath) return preloadFilePath;
  const file = path.join(
    app.getPath('temp'),
    'glassy-spotify-import-preload.js',
  );
  await writeFile(
    file,
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spotifyImport', {
  onState: (cb) => ipcRenderer.on('spotify-import:state', (_e, state) => cb(state)),
  startImport: (url) => ipcRenderer.send('spotify-import:start', url),
});
`,
    'utf8',
  );
  preloadFilePath = file;
  return file;
}

let importWin: BrowserWindow | null = null;
let handlerBound = false;

export async function openImportWindow(
  parent: BrowserWindow | null,
  onStart: (url: string) => void,
): Promise<void> {
  if (!handlerBound) {
    handlerBound = true;
    ipcMain.on('spotify-import:start', (_event, url: string) => onStart(url));
  }

  if (importWin && !importWin.isDestroyed()) {
    importWin.focus();
    return;
  }

  const win = new BrowserWindow({
    ...WINDOW_SIZE,
    parent: parent ?? undefined,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#121214',
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
    importWin = null;
  });

  await win.loadFile(await getHtmlPath());
  importWin = win;
}

export function pushImportState(state: ImportState): void {
  if (importWin && !importWin.isDestroyed()) {
    importWin.webContents.send('spotify-import:state', state);
  }
}
