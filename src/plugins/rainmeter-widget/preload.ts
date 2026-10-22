import { contextBridge, ipcRenderer } from 'electron';

import { createPreload } from '@/utils';

import type { RainmeterWidgetPluginConfig } from './index';
import type { RainmeterWidgetState } from './main';

// Exposes widget state + controls to the page (used by the renderer-side widget UI).
// Media metadata (title/artist/art/time/play-pause) is NOT duplicated here: the renderer
// already receives it directly via the existing 'peard:update-song-info' broadcast
// (see src/providers/song-info.ts), so the widget UI can listen to that channel itself.
export const preload = createPreload<unknown, RainmeterWidgetPluginConfig>({
  async start() {
    const initialState = (await ipcRenderer.invoke(
      'rainmeter-widget:get-state',
    )) as RainmeterWidgetState;

    contextBridge.exposeInMainWorld('rainmeterWidget', {
      initialState,
      getState: (): Promise<RainmeterWidgetState> =>
        ipcRenderer.invoke('rainmeter-widget:get-state'),
      toggleMode: (): Promise<RainmeterWidgetState> =>
        ipcRenderer.invoke('rainmeter-widget:toggle-mode'),
      toggleClickThrough: (): Promise<RainmeterWidgetState> =>
        ipcRenderer.invoke('rainmeter-widget:toggle-click-through'),
      onStateChange: (listener: (state: RainmeterWidgetState) => void) => {
        ipcRenderer.on(
          'rainmeter-widget:state-changed',
          (_event, state: RainmeterWidgetState) => listener(state),
        );
      },
    });
  },
});
