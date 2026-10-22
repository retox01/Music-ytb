import {
  globalShortcut,
  type BrowserWindow,
  type Event as ElectronEvent,
} from 'electron';

import { getSongControls } from '@/providers/song-controls';
import {
  MediaType,
  registerCallback,
  unregisterCallback,
  type SongInfo,
} from '@/providers/song-info';
import { createBackend } from '@/utils';

import {
  closeWidgetWindow,
  isWidgetWindowOpen,
  openWidgetWindow,
  sendWidgetData,
  setWidgetAlwaysOnTop,
  setWidgetClickThrough,
  setWidgetExpanded,
} from './widget-window';

import type { RainmeterWidgetPluginConfig } from './index';
import type { LyricsPayload } from './renderer';
import type { BackendContext } from '@/types/contexts';

const EMPTY_LYRICS: LyricsPayload = {
  lineKey: '',
  lineActivatedAt: 0,
  words: null,
  plainText: '',
};

export type RainmeterWidgetState = {
  widgetMode: boolean;
  clickThrough: boolean;
  alwaysOnTop: boolean;
};

const TOGGLE_WIDGET_MODE_SHORTCUT = 'Alt+Shift+W';
const TOGGLE_CLICK_THROUGH_SHORTCUT = 'Alt+Shift+L';

const stateOf = (
  config: RainmeterWidgetPluginConfig,
): RainmeterWidgetState => ({
  widgetMode: config.widgetMode,
  clickThrough: config.clickThrough,
  alwaysOnTop: config.alwaysOnTop,
});

// NOTE on `frame`: a brand-new BrowserWindow (the companion widget, see
// widget-window.ts) CAN be created with `frame: false` from the start — this
// plugin intentionally never touches the MAIN window's own `frame`/size/
// taskbar visibility at all anymore, since Electron cannot change `frame`
// after creation and recreating the main window would drop playback state.
// The widget is a fully independent window instead; see widget-window.ts.
export const backend = createBackend<
  {
    window: BrowserWindow | null;
    lastSongInfo: SongInfo | null;
    lastLyrics: LyricsPayload;
    lastAmbientColor: string | null;
    songInfoCallback: ((info: SongInfo) => void) | null;
    onMainWindowClose: ((event: ElectronEvent) => void) | null;
    onMainWindowHide: (() => void) | null;
    onMainWindowShow: (() => void) | null;
  },
  RainmeterWidgetPluginConfig
>({
  window: null,
  lastSongInfo: null,
  lastLyrics: EMPTY_LYRICS,
  lastAmbientColor: null,
  songInfoCallback: null,
  onMainWindowClose: null,
  onMainWindowHide: null,
  onMainWindowShow: null,

  async start(ctx: BackendContext<RainmeterWidgetPluginConfig>) {
    this.window = ctx.window;
    const config = await ctx.getConfig();

    const broadcastState = async () => {
      ctx.ipc.send(
        'rainmeter-widget:state-changed',
        stateOf(await ctx.getConfig()),
      );
    };

    const songControls = getSongControls(ctx.window);

    const pushWidgetData = async () => {
      if (!isWidgetWindowOpen()) return;
      const info = this.lastSongInfo;
      const cfg = await ctx.getConfig();
      sendWidgetData({
        title: info?.title ?? '',
        artist: info?.artist ?? '',
        imageSrc: info?.imageSrc ?? null,
        lyrics: this.lastLyrics,
        ambientColor: this.lastAmbientColor,
        isPaused: Boolean(info?.isPaused),
        elapsedSeconds: info?.elapsedSeconds ?? 0,
        songDuration: info?.songDuration ?? 0,
        videoId: info?.videoId ?? '',
        // ATV ("Audio Track Video") is YTM's own placeholder visual for
        // audio-only uploads — everything else is real video content.
        hasVideo:
          info?.mediaType !== undefined && info.mediaType !== MediaType.Audio,
        alwaysOnTop: cfg.alwaysOnTop,
      });
    };

    this.songInfoCallback = (info) => {
      this.lastSongInfo = info;
      pushWidgetData();
    };
    registerCallback(this.songInfoCallback);

    // Pushed by this plugin's own renderer.ts, which runs inside the MAIN
    // window — the only place with access to Better Lyrics' DOM and the
    // live <video> element. See renderer.ts's setWidgetActive().
    //
    // NOTE: ctx.ipc.on's listener is NOT called with the raw ipc event first
    // (see src/loader/main.ts: `ipcMain.on(event, (_, ...args) => listener(...args))`
    // strips it) — only the real arguments sent from the renderer. A listener
    // declared with an extra leading `_event` parameter silently receives
    // `undefined` in its last parameter instead (confirmed live: this exact
    // mistake is why lyrics/ambient-color/controls were never updating).
    ctx.ipc.on('rainmeter-widget:lyrics-text', (payload: LyricsPayload) => {
      this.lastLyrics = payload;
      pushWidgetData();
    });
    ctx.ipc.on('rainmeter-widget:ambient-color', (rgb: string) => {
      this.lastAmbientColor = rgb;
      pushWidgetData();
    });

    // Normally closing the main window quits the whole app (see
    // src/index.ts's 'window-all-closed' handler) — but while the widget is
    // open, the whole point is that it keeps going (and the music keeps
    // playing) without the main window around. `hide()` instead of letting
    // it actually close keeps the renderer (and the audio it's producing)
    // alive; the window simply no longer counts toward 'window-all-closed'
    // because it still exists, just invisible. Re-opening the widget's own
    // toggle (Alt+Shift+W, off) brings it back — see applyWidgetMode(false).
    this.onMainWindowClose = (event) => {
      event.preventDefault();
      ctx.window.hide();
    };
    // Nobody is looking at the main window while it's hidden this way, so
    // this is exactly the moment eco mode (shaders/video quality/frame rate,
    // see renderer.ts) is pure upside — but it's tied to actual VISIBILITY,
    // not to widgetMode, so it still applies correctly if the user hides the
    // main window some other way (minimize-to-tray plugins, etc.).
    this.onMainWindowHide = () =>
      ctx.ipc.send('rainmeter-widget:eco-mode', true);
    this.onMainWindowShow = () =>
      ctx.ipc.send('rainmeter-widget:eco-mode', false);
    ctx.window.on('hide', this.onMainWindowHide);
    ctx.window.on('show', this.onMainWindowShow);

    const applyWidgetMode = async (enable: boolean) => {
      if (enable) {
        const cfg = await ctx.getConfig();
        await openWidgetWindow(cfg.widgetBounds, cfg.alwaysOnTop, (bounds) => {
          ctx.setConfig({ widgetBounds: bounds });
        });
        pushWidgetData();
        if (this.onMainWindowClose)
          ctx.window.on('close', this.onMainWindowClose);
      } else {
        closeWidgetWindow();
        if (this.onMainWindowClose) {
          ctx.window.off('close', this.onMainWindowClose);
        }
        // The widget was the only way back if the main window got hidden via
        // the close-button override above — restore it so turning the widget
        // off never leaves the user with no visible window at all.
        if (!ctx.window.isVisible()) ctx.window.show();
      }
    };

    const toggleWidgetMode = async () => {
      const cfg = await ctx.getConfig();
      const next = !cfg.widgetMode;
      await applyWidgetMode(next);
      await ctx.setConfig({ widgetMode: next });
      await broadcastState();
      return stateOf(await ctx.getConfig());
    };

    const toggleClickThrough = async () => {
      const cfg = await ctx.getConfig();
      // Click-through only makes sense while the widget window exists;
      // ignored otherwise so a stray shortcut press can't lock the user out.
      if (!cfg.widgetMode) return stateOf(cfg);

      const next = !cfg.clickThrough;
      setWidgetClickThrough(next);
      await ctx.setConfig({ clickThrough: next });
      await broadcastState();
      return stateOf(await ctx.getConfig());
    };

    const toggleAlwaysOnTop = async () => {
      const cfg = await ctx.getConfig();
      const next = !cfg.alwaysOnTop;
      setWidgetAlwaysOnTop(next);
      await ctx.setConfig({ alwaysOnTop: next });
      await broadcastState();
      await pushWidgetData();
      return stateOf(await ctx.getConfig());
    };

    // Allow-listed on purpose: never call songControls[action](value) with an
    // unchecked string from the renderer (this is a trust boundary — the
    // companion window's own JS, but still untrusted input in principle).
    const CONTROL_ACTIONS = {
      previous: () => songControls.previous(),
      next: () => songControls.next(),
      playPause: () => songControls.playPause(),
      seekTo: (value: unknown) => songControls.seekTo(Number(value)),
    } as const;

    ctx.ipc.handle('rainmeter-widget:get-state', async () =>
      stateOf(await ctx.getConfig()),
    );
    ctx.ipc.handle('rainmeter-widget:toggle-mode', toggleWidgetMode);
    ctx.ipc.handle('rainmeter-widget:toggle-click-through', toggleClickThrough);
    ctx.ipc.handle('rainmeter-widget:toggle-always-on-top', toggleAlwaysOnTop);
    ctx.ipc.handle(
      'rainmeter-widget:control',
      (action: unknown, value: unknown) => {
        if (typeof action === 'string' && action in CONTROL_ACTIONS) {
          CONTROL_ACTIONS[action as keyof typeof CONTROL_ACTIONS](value);
        }
      },
    );
    ctx.ipc.handle('rainmeter-widget:toggle-expand', (expanded: boolean) => {
      setWidgetExpanded(Boolean(expanded));
    });

    globalShortcut.register(TOGGLE_WIDGET_MODE_SHORTCUT, () => {
      toggleWidgetMode();
    });
    globalShortcut.register(TOGGLE_CLICK_THROUGH_SHORTCUT, () => {
      toggleClickThrough();
    });

    // Resume whichever mode was active before the app last closed/restarted.
    if (config.widgetMode) {
      await applyWidgetMode(true);
      if (config.clickThrough) setWidgetClickThrough(true);
    }
  },

  stop() {
    globalShortcut.unregister(TOGGLE_WIDGET_MODE_SHORTCUT);
    globalShortcut.unregister(TOGGLE_CLICK_THROUGH_SHORTCUT);
    if (this.songInfoCallback) unregisterCallback(this.songInfoCallback);
    this.songInfoCallback = null;
    const win = this.window;
    if (win) {
      if (this.onMainWindowClose) win.off('close', this.onMainWindowClose);
      if (this.onMainWindowHide) win.off('hide', this.onMainWindowHide);
      if (this.onMainWindowShow) win.off('show', this.onMainWindowShow);
    }
    this.onMainWindowClose = null;
    this.onMainWindowHide = null;
    this.onMainWindowShow = null;
    closeWidgetWindow();
  },
});
