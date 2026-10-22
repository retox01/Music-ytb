import { globalShortcut } from 'electron';

import { getSongControls } from '@/providers/song-controls';
import { createBackend } from '@/utils';

import { openImportWindow, pushImportState } from './import-window';
import { extractVideoId } from './match-track';
import { fetchSpotifyPlaylist } from './spotify';

import type { BackendContext } from '@/types/contexts';

const OPEN_SHORTCUT = 'Alt+Shift+S';

// Sequential on purpose: each call opens its own one-shot
// ipcMain.once('peard:search-results', …) listener (see
// song-controls.ts's search()) — running them concurrently would risk one
// call's result racing into another's await. A playlist import isn't
// latency-sensitive enough to need parallelism here.
async function importPlaylist(
  url: string,
  songControls: ReturnType<typeof getSongControls>,
): Promise<void> {
  pushImportState({ phase: 'fetching' });

  let playlist: Awaited<ReturnType<typeof fetchSpotifyPlaylist>>;
  try {
    playlist = await fetchSpotifyPlaylist(url);
  } catch (err) {
    pushImportState({
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const log: { ok: boolean; title: string; artist: string }[] = [];
  let found = 0;

  for (const track of playlist.tracks) {
    pushImportState({
      phase: 'matching',
      done: log.length,
      total: playlist.tracks.length,
      log,
    });

    let videoId: string | null;
    try {
      const query = `${track.title} ${track.artist}`.trim();
      const result = await songControls.search(query);
      videoId = extractVideoId(result);
    } catch {
      videoId = null;
    }

    if (videoId) {
      songControls.addSongToQueue(videoId, 'INSERT_AT_END');
      found += 1;
    }
    log.push({ ok: !!videoId, title: track.title, artist: track.artist });
  }

  pushImportState({
    phase: 'done',
    found,
    total: playlist.tracks.length,
    log,
  });
}

export const backend = createBackend({
  start(ctx: BackendContext<{ enabled: boolean }>) {
    const songControls = getSongControls(ctx.window);
    let running = false;

    globalShortcut.register(OPEN_SHORTCUT, () => {
      openImportWindow(ctx.window, (url) => {
        // shortcut: a second "Importer" click while one is already running
        // is ignored rather than queued/cancelled — simplest safe behavior;
        // the button is already disabled client-side while running anyway.
        if (running) return;
        running = true;
        importPlaylist(url, songControls).finally(() => {
          running = false;
        });
      });
    });
  },

  stop() {
    globalShortcut.unregister(OPEN_SHORTCUT);
  },
});
