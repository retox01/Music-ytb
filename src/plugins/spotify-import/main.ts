import { globalShortcut } from 'electron';

import { getSongControls } from '@/providers/song-controls';
import { createBackend } from '@/utils';

import { openImportWindow, pushImportState } from './import-window';
import { extractVideoId } from './match-track';
import {
  extractPlaylistId,
  fetchSpotifyPlaylist,
  type SpotifyPlaylist,
} from './spotify';

import type { BackendContext } from '@/types/contexts';

const OPEN_SHORTCUT = 'Alt+Shift+S';

async function runImport(
  playlist: SpotifyPlaylist,
  songControls: ReturnType<typeof getSongControls>,
): Promise<void> {
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

  pushImportState({ phase: 'done', found, total: playlist.tracks.length, log });
}

export const backend = createBackend({
  start(ctx: BackendContext<{ enabled: boolean }>) {
    const songControls = getSongControls(ctx.window);
    let running = false;
    // Caches the last previewed playlist so clicking "Importer" doesn't
    // re-fetch Spotify — the preview step already did the one real request.
    let cached: { id: string; playlist: SpotifyPlaylist } | null = null;

    const preview = async (url: string) => {
      const id = extractPlaylistId(url);
      if (!id || id === cached?.id) return;
      try {
        const playlist = await fetchSpotifyPlaylist(url);
        cached = { id, playlist };
        pushImportState({
          phase: 'preview',
          name: playlist.name,
          coverUrl: playlist.coverUrl,
          total: playlist.tracks.length,
        });
      } catch (err) {
        pushImportState({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const confirm = () => {
      if (running || !cached) return;
      running = true;
      runImport(cached.playlist, songControls).finally(() => {
        running = false;
      });
    };

    globalShortcut.register(OPEN_SHORTCUT, () => {
      cached = null;
      openImportWindow(ctx.window, {
        // Called repeatedly while the window is open and idle (clipboard
        // polling lives in the renderer, see import-window.ts) — cheap no-op
        // via the `id === cached?.id` guard above when nothing changed.
        onLinkDetected: (url) => {
          if (!running) preview(url);
        },
        onConfirm: confirm,
      });
    });
  },

  stop() {
    globalShortcut.unregister(OPEN_SHORTCUT);
  },
});
