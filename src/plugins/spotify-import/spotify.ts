/**
 * Reads a PUBLIC Spotify playlist's track list with zero authentication:
 * no Spotify Developer app, no Client ID, no OAuth. Spotify's own public
 * embed widget (the thing you get when you "Embed playlist" from the
 * Spotify app) ships the full track list as JSON baked into the page itself
 * (`__NEXT_DATA__`, the standard Next.js data-hydration script tag) — VERIFIED
 * live against a real public playlist (open.spotify.com/embed/playlist/<id>):
 * `props.pageProps.state.data.entity.trackList[]`, each `{title, subtitle}`
 * (subtitle = artist name(s)).
 *
 * Limits (inherent to this approach, not fixed by more code):
 *   - Only works for PUBLIC playlists (private ones don't render track data
 *     into this page at all — Spotify returns the shell with no trackList).
 *   - Very long playlists may be paginated by Spotify's embed page; this
 *     reads whatever the single page load contains, no "load more" attempted.
 */

const PLAYLIST_ID_RE =
  /(?:open\.spotify\.com\/playlist\/|spotify:playlist:)([a-zA-Z0-9]+)/;

export type SpotifyTrack = { title: string; artist: string };
export type SpotifyPlaylist = {
  name: string;
  coverUrl: string | null;
  tracks: SpotifyTrack[];
};

export function extractPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(PLAYLIST_ID_RE);
  if (match) return match[1];
  // Also accept a bare ID (no URL at all) if it looks like one.
  if (/^[a-zA-Z0-9]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

export async function fetchSpotifyPlaylist(
  url: string,
): Promise<SpotifyPlaylist> {
  const id = extractPlaylistId(url);
  if (!id) {
    throw new Error(
      "Lien Spotify non reconnu — colle le lien de partage d'une playlist (ex: https://open.spotify.com/playlist/...).",
    );
  }

  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) {
    throw new Error(
      `Spotify a répondu ${res.status} — la playlist est peut-être privée, supprimée, ou le lien est incorrect.`,
    );
  }
  const html = await res.text();
  const match = html.match(
    /__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
  );
  if (!match) {
    throw new Error(
      'Page Spotify inattendue (format changé côté Spotify) — réessaie plus tard.',
    );
  }

  type Entity = {
    name?: string;
    coverArt?: { sources?: { url?: string }[] };
    trackList?: { title?: string; subtitle?: string }[];
  };
  type Parsed = {
    props?: { pageProps?: { state?: { data?: { entity?: Entity } } } };
  };
  let entity: Entity | undefined;
  try {
    const parsed = JSON.parse(match[1]) as Parsed;
    entity = parsed.props?.pageProps?.state?.data?.entity;
  } catch {
    throw new Error('Impossible de lire les données de la playlist Spotify.');
  }

  if (!entity?.trackList?.length) {
    throw new Error(
      "Aucun morceau trouvé — vérifie que la playlist est bien publique (Spotify ne partage pas le contenu d'une playlist privée sans connexion).",
    );
  }

  return {
    name: entity.name ?? 'Playlist Spotify',
    coverUrl: entity.coverArt?.sources?.[0]?.url ?? null,
    tracks: entity.trackList.map((t) => ({
      title: t.title ?? '',
      artist: t.subtitle ?? '',
    })),
  };
}
