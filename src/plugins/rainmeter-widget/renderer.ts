/**
 * Rainmeter widget — renderer/DOM side, running inside the MAIN window (the
 * actual YouTube Music page). This file does NOT build any UI of its own
 * anymore: the compact widget is a fully separate, independent BrowserWindow
 * (see ./widget-window.ts + main.ts), so the main window is left completely
 * untouched when widget mode toggles on/off.
 *
 * This file's only job is to read two things this process has uniquely
 * privileged access to and relay them to the main process (which then pushes
 * them on to the companion window) — see setWidgetActive() below:
 *   - the current Better Lyrics text (its DOM only exists in this page)
 *   - the video's live average color, for the companion window's glow
 *
 * Exported entry points, called from index.ts's `renderer()`:
 *   setWidgetActive(active, callbacks) — starts/stops both relays above.
 *   applyEcoMode(active)               — see section 1. NOT tied to widget
 *     mode itself (the companion window is a separate overlay; the main
 *     window usually stays fully visible, so degrading its rendering just
 *     because the widget is open would be a regression) — instead wired in
 *     index.ts to the MAIN WINDOW's own visibility (hidden vs shown), since
 *     main.ts now hides it instead of quitting when its close button is used
 *     while the widget is active (see main.ts) — eco mode is exactly right
 *     for that moment: nobody is looking at the main window, but it (and the
 *     audio it produces) is still running.
 */

import type { MusicPlayer } from '@/types/music-player';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getPlayerApi(): (Element & MusicPlayer) | null {
  return document.querySelector<Element & MusicPlayer>('#movie_player');
}

function getVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video');
}

// ===========================================================================
// 1. Eco mode (unchanged; see file header for why it's no longer auto-called)
// ===========================================================================

let ecoActive = false;

// --- rAF throttle (~24fps approximation) -----------------------------------
// shortcut: a caller's cancelAnimationFrame(id) won't cancel a frame that is
// still waiting inside the throttle's internal re-schedule — acceptable for
// decorative loops; upgrade with an id map if something depends on exact
// cancellation semantics. There is no Electron API to cap a normal window's
// real compositor frame rate (setFrameRate is offscreen-rendering only), so
// this is a software approximation, not a true render-rate limit.
const ECO_FRAME_INTERVAL_MS = 1000 / 24;
let nativeRAF: typeof window.requestAnimationFrame | null = null;
let lastEcoFrameTime = 0;

function throttledRAF(callback: FrameRequestCallback): number {
  const raf = nativeRAF!;
  return raf(function tick(ts: number) {
    if (ts - lastEcoFrameTime >= ECO_FRAME_INTERVAL_MS) {
      lastEcoFrameTime = ts;
      callback(ts);
    } else {
      raf(tick);
    }
  });
}

function installRAFThrottle() {
  if (nativeRAF) return; // already installed
  nativeRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = throttledRAF;
}

function uninstallRAFThrottle() {
  if (!nativeRAF) return;
  window.requestAnimationFrame = nativeRAF;
  nativeRAF = null;
}

// --- WebGL shader canvases ---------------------------------------------------
// The Better Lyrics Shaders effect runs as a loaded Chrome extension
// (session.defaultSession.loadExtension in src/plugins/better-lyrics-shaders/index.ts)
// whose content script executes in its own isolated JS world — we have no
// reference to its render loop or rAF handle from here. What IS shared across
// worlds is the DOM, so any <canvas> it creates and its WebGLRenderingContext
// (contexts belong to the element, not the world that requested them) are
// reachable. Forcing WEBGL_lose_context is the standard way to stop GPU work
// on a context from outside the script that owns it: subsequent gl.* calls
// from the shader's own loop become no-ops per spec, so even if that loop
// keeps ticking, it stops costing GPU time. Whether the shader's own JS
// additionally listens for 'webglcontextlost'/'restored' to pause/resume its
// CPU-side work is NOT verified (its source is not part of this checkout).
const lostCanvases = new WeakSet<HTMLCanvasElement>();

function getCanvasGL(
  canvas: HTMLCanvasElement,
): WebGLRenderingContext | WebGL2RenderingContext | null {
  return canvas.getContext('webgl2') ?? canvas.getContext('webgl');
}

function pauseShaderCanvases() {
  for (const canvas of document.querySelectorAll('canvas')) {
    const gl = getCanvasGL(canvas);
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) continue;
    ext.loseContext();
    lostCanvases.add(canvas);
    canvas.dataset.rainmeterEcoKilled = '1';
  }
}

function resumeShaderCanvases() {
  for (const canvas of document.querySelectorAll('canvas')) {
    if (!lostCanvases.has(canvas)) continue;
    const gl = getCanvasGL(canvas);
    gl?.getExtension('WEBGL_lose_context')?.restoreContext();
    lostCanvases.delete(canvas);
    delete canvas.dataset.rainmeterEcoKilled;
  }
}

// --- Video decode --------------------------------------------------------
// Reduces decode/render cost while keeping audio playing, via the same
// MusicPlayer API the quality-changer plugin uses (src/plugins/quality-changer,
// src/types/music-player.ts), rather than an unverified display:none hack.
let savedQuality: string | null = null;

function lowerVideoQuality() {
  const api = getPlayerApi();
  if (!api) return;
  savedQuality = api.getPlaybackQuality?.() ?? null;
  api.setPlaybackQualityRange?.('tiny');
  api.setPlaybackQuality?.('tiny');
}

function restoreVideoQuality() {
  const api = getPlayerApi();
  if (!api) return;
  api.setPlaybackQualityRange?.('auto');
  api.setPlaybackQuality?.(savedQuality ?? 'auto');
  savedQuality = null;
}

/**
 * Toggles low-power mode: kills shader canvases' GPU context, throttles
 * requestAnimationFrame to ~24fps, drops video render quality (audio keeps
 * playing — HTMLMediaElement audio output is independent of render
 * resolution/visibility), and neutralizes backdrop-filter / decorative
 * ::before/::after effects via the `rainmeter-eco` CSS class (see style.css).
 * Karaoke line-highlight animation is left untouched (see style.css comment).
 * Not currently called automatically by anything in this plugin — see file
 * header — but left callable for whoever wires it up next.
 */
export function applyEcoMode(active: boolean): void {
  if (active === ecoActive) return;
  ecoActive = active;

  document.documentElement.classList.toggle('rainmeter-eco', active);

  if (active) {
    installRAFThrottle();
    pauseShaderCanvases();
    lowerVideoQuality();
  } else {
    uninstallRAFThrottle();
    resumeShaderCanvases();
    restoreVideoQuality();
  }
}

// ===========================================================================
// 2. Lyrics relay (best-effort) — now WORD-LEVEL, to drive the companion
// window's own reveal animation instead of showing static flat text.
// ===========================================================================
// The companion window (./widget-window.ts) has no access to this page's DOM
// — it's a fully separate BrowserWindow/renderer process. Title/artist/art
// reach it directly in the main process via @/providers/song-info (see
// main.ts), but lyrics can only be read from here, because Better Lyrics
// renders as a loaded Chrome extension (session.defaultSession.loadExtension,
// see ../better-lyrics/index.ts). Real selectors/timing VERIFIED live via
// Chrome DevTools Protocol against a running build:
//   - the tab is named "Paroles" in French, not "Lyrics" (broke it the first
//     time) — matched case-insensitively across a few languages below.
//   - the currently-sung line is `.blyrics--line.blyrics--active`, built from
//     `.blyrics--word` spans. Their text nodes do NOT include spaces; a space
//     must be re-added after any word with the `blyrics--has-trailing-space`
//     class (confirmed on real lines: every word had it).
//   - each word carries inline custom properties `--blyrics-swipe-delay` and
//     `--blyrics-duration` (e.g. "1.95s", "257ms") — these are FIXED offsets
//     from the moment the *line* became active, not from absolute playback
//     time (confirmed: the first word of unrelated lines, sung minutes apart,
//     always carries almost the same ~1.95s delay) — i.e. exactly the timing
//     Better Lyrics itself uses to reveal words one by one. We don't have
//     its exact keyframes/visuals (its source isn't part of this checkout),
//     but reusing its real per-word timing lets the companion window play
//     its OWN reveal animation in sync with the actual singing, which is the
//     part that actually matters (see widget-window.ts for the animation).
// A generic whole-panel-text fallback (no per-word timing, just static text)
// is kept for instrumental sections or if a future Better Lyrics version
// changes these class names.

export type LyricsWord = {
  text: string;
  space: boolean; // render a space after this word
  delayS: number; // seconds after the line became active when this word starts revealing
  durationMs: number; // how long this word's own reveal takes
};

export type LyricsPayload = {
  lineKey: string; // identity of the current line/state, for the widget to detect changes
  lineActivatedAt: number; // Date.now() (shared wall-clock, NOT performance.now() — this
  // crosses process boundaries to the companion window, which has its own, unrelated
  // performance.now() epoch) of when this exact line first became active.
  words: LyricsWord[] | null; // null = no per-word timing available, use plainText as-is
  plainText: string;
};

/**
 * Best-effort: clicks whatever tab inside ytmusic-player-page looks like the
 * Lyrics tab (by its visible text, across the languages checked). Safe to
 * call repeatedly: it no-ops once the matching tab is already selected
 * (aria-selected/selected).
 */
function forceLyricsPanelVisible(): void {
  const page = document.querySelector('ytmusic-player-page');
  if (!page) return;
  const candidates = page.querySelectorAll<HTMLElement>(
    'tp-yt-paper-tab, [role="tab"], yt-tab-shape',
  );
  for (const tab of candidates) {
    if (!/lyrics|paroles|letra|songtext|testo/i.test(tab.textContent ?? ''))
      continue;
    const alreadySelected =
      tab.getAttribute('aria-selected') === 'true' ||
      tab.hasAttribute('selected');
    if (!alreadySelected) tab.click();
    break;
  }
}

function parseCssSeconds(raw: string): number {
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return 0;
  return raw.trim().endsWith('ms') ? v / 1000 : v;
}

function scrapeWords(active: HTMLElement): LyricsWord[] | null {
  const wordEls = active.querySelectorAll<HTMLElement>('.blyrics--word');
  if (!wordEls.length) return null;
  const words: LyricsWord[] = [];
  for (const word of wordEls) {
    const delayRaw = word.style.getPropertyValue('--blyrics-swipe-delay');
    const durationRaw = word.style.getPropertyValue('--blyrics-duration');
    words.push({
      text: word.textContent ?? '',
      space: word.classList.contains('blyrics--has-trailing-space'),
      delayS: parseCssSeconds(delayRaw),
      durationMs: parseCssSeconds(durationRaw) * 1000,
    });
  }
  return words;
}

// Tracked by DOM node identity, not text: a repeated chorus line is a
// DIFFERENT element each time it becomes active, so this still re-times it
// from the start instead of (wrongly) assuming it's "still" the earlier one.
let lastActiveLineEl: HTMLElement | null = null;
let lastLineActivatedAt = 0;

function scrapeLyricsLine(): LyricsPayload {
  const active = document.querySelector<HTMLElement>(
    '.blyrics--line.blyrics--active',
  );
  if (active) {
    if (active !== lastActiveLineEl) {
      lastActiveLineEl = active;
      lastLineActivatedAt = Date.now();
    }
    const words = scrapeWords(active);
    const plainText = words
      ? words
          .map((w) => w.text + (w.space ? ' ' : ''))
          .join('')
          .trim()
      : (active.textContent ?? '').trim();
    return {
      lineKey: `line:${lastLineActivatedAt}`,
      lineActivatedAt: lastLineActivatedAt,
      words,
      plainText,
    };
  }

  lastActiveLineEl = null;
  const page = document.querySelector('ytmusic-player-page');
  const panel = page?.querySelector<HTMLElement>(
    '#blyrics-wrapper, [class*="lyrics" i], [id*="lyrics" i], [class*="parole" i], [id*="parole" i]',
  );
  const plainText = (panel?.innerText ?? '').trim().slice(0, 400);
  return {
    lineKey: `plain:${plainText}`,
    lineActivatedAt: 0,
    words: null,
    plainText,
  };
}

// ===========================================================================
// 3. Ambient light — companion window's glow, sampled from the live video
// ===========================================================================
// Same constraint as the lyrics text above: only this page has the <video>
// element, so the average color is computed here and relayed to the
// companion window, which renders the actual glow in its own CSS.

let ambientCanvas: HTMLCanvasElement | null = null;
let ambientBroken = false; // set once sampling throws; stop retrying every tick
let ambientRGB: [number, number, number] | null = null;

const AMBIENT_SAMPLE_SIZE = 16; // tiny on purpose: only the average color matters
const AMBIENT_SMOOTHING = 0.15; // exponential smoothing so color eases instead of snapping

function sampleAmbientColor(onColor: (rgb: string) => void): void {
  if (ambientBroken) return;
  const video = getVideo();
  if (!video || video.readyState < 2 || video.videoWidth === 0) return;

  if (!ambientCanvas) {
    ambientCanvas = document.createElement('canvas');
    ambientCanvas.width = AMBIENT_SAMPLE_SIZE;
    ambientCanvas.height = AMBIENT_SAMPLE_SIZE;
  }
  const ctx = ambientCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  try {
    ctx.drawImage(video, 0, 0, AMBIENT_SAMPLE_SIZE, AMBIENT_SAMPLE_SIZE);
    const { data } = ctx.getImageData(
      0,
      0,
      AMBIENT_SAMPLE_SIZE,
      AMBIENT_SAMPLE_SIZE,
    );
    let r = 0;
    let g = 0;
    let b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    r /= n;
    g /= n;
    b /= n;

    const lerp = (from: number, to: number) => {
      const step = (to - from) * AMBIENT_SMOOTHING;
      return from + step;
    };
    ambientRGB = ambientRGB
      ? [lerp(ambientRGB[0], r), lerp(ambientRGB[1], g), lerp(ambientRGB[2], b)]
      : [r, g, b];

    const [sr, sg, sb] = ambientRGB.map((v) => Math.round(v));
    onColor(`${sr}, ${sg}, ${sb}`);
  } catch (err) {
    // shortcut: a cross-origin/tainted <video> source would throw a
    // SecurityError on every getImageData call forever — give up permanently
    // instead of retrying every tick. Not verified against a real playback session
    // (could not launch the Electron app in this environment) — check the
    // devtools console for this warning first if the glow never appears.
    ambientBroken = true;
    console.warn('[rainmeter-widget] ambient light sampling disabled:', err);
  }
}

// ===========================================================================
// 4. Widget lifecycle — starts/stops both relays above together
// ===========================================================================

export type WidgetRelayCallbacks = {
  sendLyrics: (payload: LyricsPayload) => void;
  sendAmbientColor: (rgb: string) => void;
};

let relayTimer: ReturnType<typeof setInterval> | null = null;

// Tighter than the original 500ms: a new active line is only detected on the
// tick that happens to land after it starts, so a shorter interval means less
// visible lag before the companion window's reveal animation kicks off. Still
// cheap: a handful of DOM queries plus a 16x16 canvas sample (see ambient
// light below), nowhere near what the eco-mode section further up is built
// to cut (shaders, 1080p+ video decode, uncapped frame rate).
const RELAY_INTERVAL_MS = 200;

/**
 * Starts/stops relaying lyrics + ambient color to the companion window while
 * widget mode is on. Idempotent, safe to call repeatedly.
 */
export function setWidgetActive(
  active: boolean,
  callbacks: WidgetRelayCallbacks,
): void {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
  if (!active) return;

  forceLyricsPanelVisible();
  relayTimer = setInterval(() => {
    forceLyricsPanelVisible();
    callbacks.sendLyrics(scrapeLyricsLine());
    sampleAmbientColor(callbacks.sendAmbientColor);
  }, RELAY_INTERVAL_MS);
}
