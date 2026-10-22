/**
 * The compact "Rainmeter widget" companion window: a fully independent
 * BrowserWindow (its own frame-less page, not the main app's UI resized or
 * hidden with CSS). Because it is a brand-new window, `frame: false` can be
 * set at construction time — unlike the main window, which cannot change its
 * `frame` after creation (see main.ts's note on that constraint); this is why
 * the design moved to a separate window instead of transforming the main one.
 *
 * Content is 100% driven by live IPC pushes (title/artist/art/lyrics/ambient
 * color — see sendWidgetData()), so the page itself is a static string
 * written to a temp file at runtime, the same "no bundler entry needed"
 * technique already used by src/plugins/skip-ai-music's picker dialogs (see
 * its editor-utils.ts) — reused here instead of registering a new Vite page.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, type Rectangle } from 'electron';

import { startPinBelow, stopPinBelow } from './pin-below';

import type { LyricsPayload } from './renderer';

export type WidgetPayload = {
  title: string;
  artist: string;
  imageSrc: string | null;
  lyrics: LyricsPayload;
  ambientColor: string | null; // "r, g, b", see renderer.ts's sampleAmbientColor()
  isPaused: boolean;
  elapsedSeconds: number;
  songDuration: number;
  videoId: string;
  hasVideo: boolean; // false for YTM's audio-only "ATV" placeholder, see main.ts
  alwaysOnTop: boolean; // reflected by the pin button top-left; see setWidgetAlwaysOnTop()
};

// Compact: readable at a glance (art + title/artist in a fixed-width column,
// lyrics getting the rest of the width, controls/seek bar below). Expanded
// (the "agrandir" button): same bottom controls, a 16:9 video area on top.
const WIDGET_COMPACT_SIZE = { width: 360, height: 168 };
const WIDGET_EXPANDED_SIZE = { width: 480, height: 420 };

// Material-style glyphs (same technique as the removed in-window shell had):
// plain SVG paths, not emoji — emoji glyphs render inconsistently across
// fonts/OSes, undermining the "improve the visual quality" ask.
const ICON_PREV = 'M6 6h2v12H6zm3.5 6 8.5 6V6z';
const ICON_NEXT = 'M16 6h2v12h-2zM6 6l8.5 6L6 18z';
const ICON_PLAY = 'M8 5v14l11-7z';
const ICON_PAUSE = 'M6 5h4v14H6zm8 0h4v14h-4z';
const ICON_EXPAND =
  'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
const ICON_COLLAPSE =
  'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';
const ICON_PIN = 'M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z';

const WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title></title>
<style>
  :root { color-scheme: dark; --rw-ambient: 60, 60, 70; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: transparent;
  }
  body {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 10px;
    gap: 8px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    color: rgba(255, 255, 255, 0.95);
    font-family: 'Segoe UI', Roboto, sans-serif;
    -webkit-app-region: drag;
    -webkit-user-select: none;
    background:
      radial-gradient(circle at 15% 0%, rgba(var(--rw-ambient), 0.55), transparent 60%),
      radial-gradient(circle at 100% 100%, rgba(var(--rw-ambient), 0.35), transparent 65%),
      rgba(15, 15, 18, 0.92);
    box-shadow: inset 0 0 40px rgba(var(--rw-ambient), 0.25);
    transition: opacity 0.3s ease;
  }
  #main-row { display: flex; align-items: center; gap: 14px; flex: 1 1 auto; min-height: 0; }
  #art {
    width: 80px;
    height: 80px;
    border-radius: 10px;
    object-fit: cover;
    flex: none;
    background: rgba(255, 255, 255, 0.08);
  }
  #meta { flex: none; width: 92px; min-width: 0; }
  #title, #artist {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #title { font-size: 13px; font-weight: 700; }
  #artist { font-size: 11px; opacity: 0.75; margin-top: 2px; }
  #lyrics {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  }
  #lyrics:empty::before { content: '♪ …'; opacity: 0.4; font-weight: 400; }
  /* Word-by-word reveal, timed from real Better Lyrics per-word data relayed
     by renderer.ts (--blyrics-swipe-delay/--blyrics-duration) — a native CSS
     animation with a (possibly negative) per-word delay set once when the
     line is built, not a continuous JS loop: cheap, and correctly resumes
     mid-animation for words whose reveal already started before this
     window saw the line (see setVideoFrame-adjacent code below). */
  .rw-word {
    opacity: 0.35;
    filter: blur(1.5px);
  }
  .rw-word.rw-anim {
    animation-name: rw-reveal;
    animation-timing-function: ease-out;
    animation-fill-mode: forwards;
  }
  @keyframes rw-reveal {
    to {
      opacity: 1;
      filter: blur(0);
      text-shadow: 0 0 10px rgba(var(--rw-ambient), 0.9);
    }
  }

  #video-row {
    display: none;
    flex: none;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 10px;
    overflow: hidden;
    background: #000;
    -webkit-app-region: no-drag;
  }
  body.rw-expanded #video-row { display: block; }
  body.rw-expanded #main-row { flex: none; }
  #video-frame { width: 100%; height: 100%; border: 0; }

  #controls-row {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    -webkit-app-region: no-drag;
  }
  .rw-btn {
    flex: none;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    cursor: pointer;
  }
  .rw-btn:hover { background: rgba(255, 255, 255, 0.2); }
  .rw-btn svg { width: 16px; height: 16px; fill: currentColor; }
  #btn-playpause { width: 32px; height: 32px; }
  #btn-playpause svg { width: 18px; height: 18px; }
  #progress {
    flex: 1 1 auto;
    height: 5px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.15);
    cursor: pointer;
    position: relative;
  }
  #progress-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0%;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.92);
    pointer-events: none;
  }
  #time { flex: none; font-size: 10px; opacity: 0.7; min-width: 34px; text-align: right; }

  #btn-pin {
    position: absolute;
    top: 6px;
    left: 6px;
    width: 22px;
    height: 22px;
    background: rgba(0, 0, 0, 0.3);
    opacity: 0.55;
    -webkit-app-region: no-drag;
  }
  #btn-pin svg { width: 13px; height: 13px; }
  #btn-pin.rw-pin-active {
    background: rgba(var(--rw-ambient), 0.85);
    opacity: 1;
  }
</style>
</head>
<body>
  <button type="button" class="rw-btn" id="btn-pin" title="Toujours au-dessus / derrière les autres fenêtres"><svg viewBox="0 0 24 24"><path d="${ICON_PIN}"/></svg></button>
  <div id="main-row">
    <img id="art" alt="" />
    <div id="meta">
      <div id="title"></div>
      <div id="artist"></div>
    </div>
    <div id="lyrics"></div>
  </div>
  <div id="video-row"><iframe id="video-frame" allow="autoplay" frameborder="0"></iframe></div>
  <div id="controls-row">
    <button type="button" class="rw-btn" id="btn-prev"><svg viewBox="0 0 24 24"><path d="${ICON_PREV}"/></svg></button>
    <button type="button" class="rw-btn" id="btn-playpause"><svg viewBox="0 0 24 24"><path d="${ICON_PLAY}"/></svg></button>
    <button type="button" class="rw-btn" id="btn-next"><svg viewBox="0 0 24 24"><path d="${ICON_NEXT}"/></svg></button>
    <div id="progress"><div id="progress-fill"></div></div>
    <span id="time">0:00</span>
    <button type="button" class="rw-btn" id="btn-expand" title="Agrandir / vidéo"><svg viewBox="0 0 24 24"><path d="${ICON_EXPAND}"/></svg></button>
  </div>
  <script>
    const fmt = (s) => {
      s = Math.max(0, Math.floor(s || 0));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };

    let latest = { elapsedSeconds: 0, songDuration: 0, isPaused: true, videoId: '', hasVideo: false };
    let lastUpdateAt = performance.now();
    let expanded = false;
    let currentLyricsLineKey = null;

    function renderLyrics(lyrics) {
      if (!lyrics || lyrics.lineKey === currentLyricsLineKey) return;
      currentLyricsLineKey = lyrics.lineKey;
      const el = document.getElementById('lyrics');
      el.innerHTML = '';
      if (!lyrics.words) {
        el.textContent = lyrics.plainText || '';
        return;
      }
      // Elapsed time since the line itself became active, measured once right
      // now: each word's animation-delay is set relative to this instant, so
      // a word whose reveal should already be done/in-progress (this window
      // only just received the line, or missed a tick) starts with a
      // negative delay — CSS animations handle that natively, jumping
      // straight to the correct mid-animation frame instead of replaying.
      const elapsedMs = Date.now() - lyrics.lineActivatedAt;
      for (const word of lyrics.words) {
        const span = document.createElement('span');
        span.className = 'rw-word rw-anim';
        span.textContent = word.text + (word.space ? ' ' : '');
        span.style.animationDuration = Math.max(1, word.durationMs) + 'ms';
        span.style.animationDelay = (word.delayS * 1000 - elapsedMs) + 'ms';
        el.appendChild(span);
      }
    }

    function renderProgress() {
      const extra = latest.isPaused ? 0 : (performance.now() - lastUpdateAt) / 1000;
      const pos = Math.min(latest.songDuration, latest.elapsedSeconds + extra);
      const pct = latest.songDuration > 0 ? (pos / latest.songDuration) * 100 : 0;
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('time').textContent = fmt(pos) + ' / ' + fmt(latest.songDuration);
    }
    setInterval(renderProgress, 250);

    function setVideoFrame() {
      const frame = document.getElementById('video-frame');
      if (expanded && latest.hasVideo && latest.videoId) {
        frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(latest.videoId)
          + '?autoplay=1&mute=1&controls=0&modestbranding=1&start=' + Math.floor(latest.elapsedSeconds);
      } else {
        frame.src = '';
      }
    }

    window.rainmeterWidgetData.onUpdate((data) => {
      const videoChanged = data.videoId !== latest.videoId;
      latest = data;
      lastUpdateAt = performance.now();

      document.getElementById('art').src = data.imageSrc || '';
      document.getElementById('title').textContent = data.title || '';
      document.getElementById('artist').textContent = data.artist || '';
      renderLyrics(data.lyrics);
      if (data.ambientColor) document.body.style.setProperty('--rw-ambient', data.ambientColor);
      document.body.style.opacity = data.isPaused ? '0.55' : '1';
      document.getElementById('btn-playpause').innerHTML =
        '<svg viewBox="0 0 24 24"><path d="' + (data.isPaused ? '${ICON_PLAY}' : '${ICON_PAUSE}') + '"/></svg>';
      document.getElementById('btn-pin').classList.toggle('rw-pin-active', !!data.alwaysOnTop);
      renderProgress();
      // shortcut: re-navigating the iframe on every song change is not frame-
      // accurate playback sync, just "roughly the right moment" — a real sync
      // would need the YouTube IFrame Player API instead of a plain <iframe>.
      if (expanded && videoChanged) setVideoFrame();
    });

    document.getElementById('btn-pin').addEventListener('click', () => window.rainmeterWidgetData.toggleAlwaysOnTop());
    document.getElementById('btn-prev').addEventListener('click', () => window.rainmeterWidgetData.control('previous'));
    document.getElementById('btn-next').addEventListener('click', () => window.rainmeterWidgetData.control('next'));
    document.getElementById('btn-playpause').addEventListener('click', () => window.rainmeterWidgetData.control('playPause'));
    document.getElementById('progress').addEventListener('click', (e) => {
      if (!latest.songDuration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      window.rainmeterWidgetData.control('seekTo', ratio * latest.songDuration);
    });
    document.getElementById('btn-expand').addEventListener('click', () => {
      expanded = !expanded;
      if (expanded && !latest.hasVideo) { expanded = false; return; }
      document.body.classList.toggle('rw-expanded', expanded);
      document.getElementById('btn-expand').innerHTML =
        '<svg viewBox="0 0 24 24"><path d="' + (expanded ? '${ICON_COLLAPSE}' : '${ICON_EXPAND}') + '"/></svg>';
      setVideoFrame();
      window.rainmeterWidgetData.toggleExpand(expanded);
    });
  </script>
</body>
</html>`;

let htmlFilePath: string | null = null;
async function getWidgetHtmlPath(): Promise<string> {
  htmlFilePath ??= path.join(app.getPath('temp'), 'rainmeter-widget.html');
  await writeFile(htmlFilePath, WIDGET_HTML, 'utf8');
  return htmlFilePath;
}

let preloadFilePath: string | null = null;
async function getWidgetPreloadPath(): Promise<string> {
  if (preloadFilePath) return preloadFilePath;
  const file = path.join(app.getPath('temp'), 'rainmeter-widget-preload.js');
  await writeFile(
    file,
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rainmeterWidgetData', {
  onUpdate: (cb) => ipcRenderer.on('rainmeter-widget:data', (_e, data) => cb(data)),
  control: (action, value) => ipcRenderer.invoke('rainmeter-widget:control', action, value),
  toggleExpand: (expanded) => ipcRenderer.invoke('rainmeter-widget:toggle-expand', expanded),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('rainmeter-widget:toggle-always-on-top'),
});
`,
    'utf8',
  );
  preloadFilePath = file;
  return file;
}

let widgetWin: BrowserWindow | null = null;
let pinTimer: NodeJS.Timeout | null = null;

export function isWidgetWindowOpen(): boolean {
  return !!widgetWin && !widgetWin.isDestroyed();
}

export async function openWidgetWindow(
  savedBounds: Rectangle | null,
  initialAlwaysOnTop: boolean,
  onBoundsChange: (bounds: Rectangle) => void,
): Promise<BrowserWindow> {
  if (isWidgetWindowOpen()) return widgetWin!;

  const win = new BrowserWindow({
    ...WIDGET_COMPACT_SIZE,
    ...(savedBounds ?? {}),
    frame: false,
    skipTaskbar: true,
    show: false,
    resizable: true,
    alwaysOnTop: initialAlwaysOnTop,
    autoHideMenuBar: true,
    backgroundColor: '#0f0f12',
    webPreferences: {
      preload: await getWidgetPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenu(null);

  let saveTimer: NodeJS.Timeout | null = null;
  const saveBounds = () => {
    // Skip bounds saved while setWidgetExpanded() is resizing the window —
    // otherwise the expanded size would get persisted as if it were the
    // user's own compact placement, see setWidgetExpanded() below.
    if (suppressBoundsSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => onBoundsChange(win.getBounds()), 500);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer);
    stopPinBelow(pinTimer);
    pinTimer = null;
    widgetWin = null;
  });

  await win.loadFile(await getWidgetHtmlPath());

  // Only one z-order mode runs at a time: starting both alwaysOnTop (native)
  // and the pin-below interval together would fight each other every ~2.5s.
  if (!initialAlwaysOnTop) pinTimer = startPinBelow(win);
  widgetWin = win;
  return win;
}

export function closeWidgetWindow(): void {
  stopPinBelow(pinTimer);
  pinTimer = null;
  if (isWidgetWindowOpen()) widgetWin!.close();
  widgetWin = null;
}

let suppressBoundsSave = false;
let preExpandBounds: Rectangle | null = null;

/**
 * Resizes the companion window for the "agrandir" button (video view) and
 * back. Keeps the window's current top-left corner, only changes the size,
 * so expanding/collapsing doesn't make it jump somewhere else on screen.
 */
export function setWidgetExpanded(expanded: boolean): void {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  suppressBoundsSave = true;

  if (expanded) {
    preExpandBounds = widgetWin.getBounds();
    widgetWin.setBounds({
      x: preExpandBounds.x,
      y: preExpandBounds.y,
      ...WIDGET_EXPANDED_SIZE,
    });
  } else {
    const { x, y } = preExpandBounds ?? widgetWin.getBounds();
    widgetWin.setBounds({ x, y, ...WIDGET_COMPACT_SIZE });
    preExpandBounds = null;
  }

  // shortcut: fixed delay instead of waiting for the 'resize' event itself —
  // simpler, and 50ms is well past when Windows/X11 fire it for a programmatic
  // setBounds call.
  setTimeout(() => {
    suppressBoundsSave = false;
  }, 50);
}

export function sendWidgetData(payload: WidgetPayload): void {
  if (isWidgetWindowOpen()) {
    widgetWin!.webContents.send('rainmeter-widget:data', payload);
  }
}

export function setWidgetClickThrough(enabled: boolean): void {
  widgetWin?.setIgnoreMouseEvents(enabled, { forward: true });
}

/**
 * Switches the widget between floating above every window (native,
 * `setAlwaysOnTop`) and pinned behind every window (pin-below.ts's
 * interval-based trick) — the two are mutually exclusive, see
 * openWidgetWindow()'s matching comment.
 */
export function setWidgetAlwaysOnTop(alwaysOnTop: boolean): void {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  if (alwaysOnTop) {
    stopPinBelow(pinTimer);
    pinTimer = null;
    widgetWin.setAlwaysOnTop(true, 'screen-saver');
  } else {
    widgetWin.setAlwaysOnTop(false);
    pinTimer = startPinBelow(widgetWin);
  }
}
