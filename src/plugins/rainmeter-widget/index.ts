import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend, type RainmeterWidgetState } from './main';
import { preload } from './preload';
import { applyEcoMode, setWidgetActive, type LyricsPayload } from './renderer';
import style from './style.css?inline';

import type { RendererContext } from '@/types/contexts';

export type RainmeterWidgetPluginConfig = {
  enabled: boolean;
  /** Whether the companion "desktop widget" window is open. */
  widgetMode: boolean;
  /** Whether mouse clicks pass through the widget window; only meaningful while widgetMode is on. */
  clickThrough: boolean;
  /** true = floats above every other window (native setAlwaysOnTop); false = pinned
   * BEHIND every other window (the original "Rainmeter" look, see pin-below.ts).
   * Toggled from the small pin button top-left of the widget. */
  alwaysOnTop: boolean;
  /** Widget window bounds, saved as it is moved/resized, restored the next time it opens. */
  widgetBounds: Electron.Rectangle | null;
};

export default createPlugin({
  name: () => t('plugins.rainmeter-widget.name'),
  description: () => t('plugins.rainmeter-widget.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    // Both default to true: the first time someone enables this plugin, the
    // widget should actually be visible and on top right away — defaulting
    // widgetMode to false (so enabling the plugin did nothing until the user
    // discovered the Alt+Shift+W shortcut on their own) and always starting
    // pinned behind every window (invisible if anything covered that screen
    // area) together meant "I enabled it and nothing showed up".
    widgetMode: true,
    clickThrough: false,
    alwaysOnTop: true,
    widgetBounds: null,
  } as RainmeterWidgetPluginConfig,

  stylesheets: [style],
  backend,
  preload,
  renderer(context: RendererContext<RainmeterWidgetPluginConfig>) {
    // `window.rainmeterWidget` is exposed by ./preload.ts via contextBridge;
    // this plugin's own renderer code runs in the same (main) world so it can
    // read it directly, same as any other page script.
    const api = (
      window as unknown as {
        rainmeterWidget?: {
          initialState: RainmeterWidgetState;
          onStateChange: (cb: (state: RainmeterWidgetState) => void) => void;
        };
      }
    ).rainmeterWidget;
    if (!api) return;

    const callbacks = {
      sendLyrics: (payload: LyricsPayload) => {
        context.ipc.send('rainmeter-widget:lyrics-text', payload);
      },
      sendAmbientColor: (rgb: string) => {
        context.ipc.send('rainmeter-widget:ambient-color', rgb);
      },
    };

    setWidgetActive(api.initialState.widgetMode, callbacks);
    api.onStateChange((state) => setWidgetActive(state.widgetMode, callbacks));

    // Pushed by main.ts when the MAIN window itself is hidden/shown — not
    // tied to widgetMode (see applyEcoMode's doc comment in renderer.ts).
    context.ipc.on('rainmeter-widget:eco-mode', (active: boolean) => {
      applyEcoMode(active);
    });
  },
});
