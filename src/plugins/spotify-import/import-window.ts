/**
 * Standalone "Importer une playlist Spotify" window. Same "temp HTML + tiny
 * preload, no bundler entry" technique already used by
 * src/plugins/skip-ai-music, src/plugins/rainmeter-widget and
 * src/providers/updater-window.ts.
 *
 * UX goal (explicitly asked for): as close to zero-effort as possible — copy
 * the playlist's share link in Spotify (Ctrl+C), the window (already open,
 * or opened with Alt+Shift+S) notices the clipboard on its own and shows a
 * preview card (cover, name, track count); one click on "Importer" starts
 * the real work. No URL field to paste into by hand in the common case.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, clipboard, ipcMain } from 'electron';

export type ImportLogEntry = {
  ok: boolean;
  title: string;
  artist: string;
};

export type ImportState =
  | { phase: 'idle' }
  | { phase: 'preview'; name: string; coverUrl: string | null; total: number }
  | { phase: 'matching'; done: number; total: number; log: ImportLogEntry[] }
  | { phase: 'done'; found: number; total: number; log: ImportLogEntry[] }
  | { phase: 'error'; message: string };

const WINDOW_SIZE = { width: 420, height: 520 };

const IMPORT_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>Importer une playlist Spotify</title>
<style>
  :root { color-scheme: dark; --spotify: 29, 185, 84; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: #0f0f12;
    font-family: 'Segoe UI', Roboto, sans-serif;
    color: rgba(255, 255, 255, 0.95);
    -webkit-user-select: none;
  }
  body { display: flex; flex-direction: column; gap: 14px; padding: 18px; height: 100%; }
  h1 { margin: 0; font-size: 15px; display: flex; align-items: center; gap: 8px; }
  h1 .dot { width: 9px; height: 9px; border-radius: 50%; background: rgb(var(--spotify)); flex: none; }
  p.hint { margin: 0; font-size: 11px; opacity: 0.55; line-height: 1.5; }

  #watch-state {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    opacity: 0.6;
    padding: 10px 2px;
  }
  #watch-state .pulse {
    width: 7px; height: 7px; border-radius: 50%;
    background: rgb(var(--spotify));
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .3; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }

  #card {
    display: none;
    gap: 14px;
    align-items: center;
    padding: 14px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(var(--spotify), 0.18), rgba(255,255,255,0.04));
    border: 1px solid rgba(var(--spotify), 0.35);
  }
  #card.show { display: flex; }
  #cover {
    width: 64px; height: 64px; border-radius: 8px; object-fit: cover; flex: none;
    background: rgba(255,255,255,0.08);
  }
  #card-meta { min-width: 0; }
  #card-name { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #card-count { font-size: 12px; opacity: 0.7; margin-top: 2px; }

  #confirm-btn {
    border: none;
    border-radius: 10px;
    padding: 11px;
    font-size: 13px;
    font-weight: 700;
    background: rgb(var(--spotify));
    color: #06230f;
    cursor: pointer;
    display: none;
  }
  #confirm-btn.show { display: block; }
  #confirm-btn:hover { filter: brightness(1.08); }
  #confirm-btn:disabled { opacity: 0.5; cursor: default; }

  #bar-track { height: 7px; border-radius: 4px; background: rgba(255,255,255,0.12); overflow: hidden; display: none; }
  #bar-track.show { display: block; }
  #bar-fill { height: 100%; width: 0%; border-radius: 4px; background: rgb(var(--spotify)); transition: width 0.25s ease; }
  #progress-text { font-size: 12px; opacity: 0.8; margin: 0; }

  #log {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    border-radius: 10px;
    background: #1b1b1e;
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.7;
    display: none;
  }
  #log.show { display: block; }
  .ok { color: #7ee787; }
  .ko { color: #ff8a8a; }
  #error { color: #ff8a8a; font-size: 12px; display: none; }
</style>
</head>
<body>
  <h1><span class="dot"></span>Importer une playlist Spotify</h1>
  <p class="hint">Copie le lien de partage d'une playlist Spotify <b>publique</b> (clic droit → Partager → Copier le lien) — détecté automatiquement ici, rien à coller.</p>

  <div id="watch-state"><span class="pulse"></span><span id="watch-text">En attente d'un lien Spotify copié…</span></div>

  <div id="card">
    <img id="cover" alt="" />
    <div id="card-meta">
      <div id="card-name"></div>
      <div id="card-count"></div>
    </div>
  </div>
  <button type="button" id="confirm-btn">Importer</button>

  <div id="bar-track"><div id="bar-fill"></div></div>
  <p id="progress-text"></p>
  <p id="error"></p>
  <div id="log"></div>

  <script>
    const watchState = document.getElementById('watch-state');
    const watchText = document.getElementById('watch-text');
    const card = document.getElementById('card');
    const cover = document.getElementById('cover');
    const cardName = document.getElementById('card-name');
    const cardCount = document.getElementById('card-count');
    const confirmBtn = document.getElementById('confirm-btn');
    const barTrack = document.getElementById('bar-track');
    const barFill = document.getElementById('bar-fill');
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
        watchState.style.display = 'flex';
        card.classList.remove('show');
        confirmBtn.classList.remove('show');
        barTrack.classList.remove('show');
        logEl.classList.remove('show');
        progressText.textContent = '';
      } else if (state.phase === 'preview') {
        watchState.style.display = 'none';
        card.classList.add('show');
        cover.src = state.coverUrl || '';
        cardName.textContent = state.name;
        cardCount.textContent = state.total + ' titres';
        confirmBtn.classList.add('show');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Importer';
        barTrack.classList.remove('show');
        logEl.classList.remove('show');
        progressText.textContent = '';
      } else if (state.phase === 'matching') {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Import en cours…';
        barTrack.classList.add('show');
        logEl.classList.add('show');
        const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
        barFill.style.width = pct + '%';
        progressText.textContent = state.done + ' / ' + state.total;
        renderLog(state.log);
      } else if (state.phase === 'done') {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Réimporter';
        barFill.style.width = '100%';
        progressText.textContent = state.found + ' / ' + state.total + " morceaux ajoutés à la file d'attente 🎉";
        renderLog(state.log);
      } else if (state.phase === 'error') {
        watchState.style.display = 'flex';
        watchText.textContent = "En attente d'un lien Spotify copié…";
        card.classList.remove('show');
        confirmBtn.classList.remove('show');
        errorEl.style.display = '';
        errorEl.textContent = state.message;
      }
    });

    confirmBtn.addEventListener('click', () => window.spotifyImport.confirm());

    // Clipboard auto-detection: polling is the only reliable cross-platform
    // way to notice an external app's clipboard change (no OS "clipboard
    // changed" event is exposed to Electron) — 1.2s is frequent enough to
    // feel instant without being wasteful.
    let lastSeen = '';
    setInterval(async () => {
      const text = await window.spotifyImport.getClipboard();
      if (text && text !== lastSeen) {
        lastSeen = text;
        if (/spotify/i.test(text)) window.spotifyImport.linkDetected(text);
      }
    }, 1200);
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
  getClipboard: () => ipcRenderer.invoke('spotify-import:get-clipboard'),
  linkDetected: (url) => ipcRenderer.send('spotify-import:link-detected', url),
  confirm: () => ipcRenderer.send('spotify-import:confirm'),
});
`,
    'utf8',
  );
  preloadFilePath = file;
  return file;
}

let importWin: BrowserWindow | null = null;
let handlersBound = false;

export type ImportWindowCallbacks = {
  onLinkDetected: (url: string) => void;
  onConfirm: () => void;
};

export async function openImportWindow(
  parent: BrowserWindow | null,
  callbacks: ImportWindowCallbacks,
): Promise<void> {
  if (!handlersBound) {
    handlersBound = true;
    ipcMain.handle('spotify-import:get-clipboard', () => clipboard.readText());
    ipcMain.on('spotify-import:link-detected', (_event, url: string) =>
      callbacks.onLinkDetected(url),
    );
    ipcMain.on('spotify-import:confirm', () => callbacks.onConfirm());
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
    importWin = null;
  });

  await win.loadFile(await getHtmlPath());
  importWin = win;
  pushImportState({ phase: 'idle' });

  // Also check the clipboard right away on open — most people will have
  // already copied the link before pressing the shortcut.
  const clip = win.webContents.executeJavaScript(
    'window.spotifyImport.getClipboard()',
  );
  clip
    .then((text: string) => {
      if (text && /spotify/i.test(text)) callbacks.onLinkDetected(text);
    })
    .catch(() => {});
}

export function pushImportState(state: ImportState): void {
  if (importWin && !importWin.isDestroyed()) {
    importWin.webContents.send('spotify-import:state', state);
  }
}
