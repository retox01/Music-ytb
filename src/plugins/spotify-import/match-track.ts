/**
 * Picks a YouTube Music videoId out of the app's own internal search API
 * response (the same `/search` endpoint the real search box uses — see
 * src/renderer.ts's 'peard:search' handler / src/providers/song-controls.ts's
 * `search()`). Response shape VERIFIED live via Chrome DevTools Protocol
 * against real queries, two cases found:
 *   - a "top result" card (`musicCardShelfRenderer`) when there's a strong
 *     match — its own videoId, preferred when present (it's YTM's own best
 *     guess, usually right).
 *   - otherwise a flat list of `itemSectionRenderer` sections, each wrapping
 *     ONE result (not always a song — artists/albums show up too, with no
 *     videoId, so skip those and keep the first one that has one).
 * A `musicShelfRenderer` (contents grouped under a titled shelf, e.g.
 * "Chansons") wasn't seen in testing but is handled too since it's documented
 * YTM response shape elsewhere in this app — same item shape inside.
 */

type JsonObject = Record<string, unknown>;

function asObject(v: unknown): JsonObject | null {
  return v && typeof v === 'object' ? (v as JsonObject) : null;
}

function videoIdFromCardShelf(card: JsonObject): string | null {
  const title = asObject(card.title);
  const runs = title?.runs;
  if (!Array.isArray(runs) || !runs[0]) return null;
  const run = asObject(runs[0]);
  const nav = asObject(run?.navigationEndpoint);
  const watch = asObject(nav?.watchEndpoint);
  return typeof watch?.videoId === 'string' ? watch.videoId : null;
}

function videoIdFromListItem(item: JsonObject): string | null {
  const overlay = asObject(item.overlay);
  const overlayRenderer = asObject(overlay?.musicItemThumbnailOverlayRenderer);
  const content = asObject(overlayRenderer?.content);
  const playButton = asObject(content?.musicPlayButtonRenderer);
  const nav = asObject(playButton?.playNavigationEndpoint);
  const watch = asObject(nav?.watchEndpoint);
  return typeof watch?.videoId === 'string' ? watch.videoId : null;
}

export function extractVideoId(searchResponse: unknown): string | null {
  try {
    const root = asObject(searchResponse);
    const tabbed = asObject(root?.contents)?.tabbedSearchResultsRenderer;
    const tabs = asObject(tabbed)?.tabs;
    if (!Array.isArray(tabs) || !tabs[0]) return null;
    const tabRenderer = asObject(asObject(tabs[0])?.tabRenderer);
    const sectionList = asObject(tabRenderer?.content)?.sectionListRenderer;
    const sections = asObject(sectionList)?.contents;
    if (!Array.isArray(sections)) return null;

    for (const sectionRaw of sections) {
      const section = asObject(sectionRaw);
      if (!section) continue;

      const card = asObject(section.musicCardShelfRenderer);
      if (card) {
        const vid = videoIdFromCardShelf(card);
        if (vid) return vid;
      }

      const itemSection = asObject(section.itemSectionRenderer);
      const entries = itemSection?.contents;
      if (!Array.isArray(entries)) continue;

      for (const entryRaw of entries) {
        const entry = asObject(entryRaw);
        if (!entry) continue;

        const listItem = asObject(entry.musicResponsiveListItemRenderer);
        if (listItem) {
          const vid = videoIdFromListItem(listItem);
          if (vid) return vid;
        }

        const shelf = asObject(entry.musicShelfRenderer);
        const shelfContents = shelf?.contents;
        if (Array.isArray(shelfContents)) {
          for (const shelfEntryRaw of shelfContents) {
            const shelfItem = asObject(
              asObject(shelfEntryRaw)?.musicResponsiveListItemRenderer,
            );
            if (!shelfItem) continue;
            const vid = videoIdFromListItem(shelfItem);
            if (vid) return vid;
          }
        }
      }
    }
  } catch {
    // Any unexpected shape just means "no match found" rather than a crash.
  }
  return null;
}
