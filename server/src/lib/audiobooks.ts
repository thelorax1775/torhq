import type { ProwlarrRelease } from "../adapters/prowlarr.js";
import { titleMatches } from "./books.js";

/**
 * Audiobook release ranking. Pure, no I/O. Prowlarr's newznab category for
 * audiobooks is 3030 (Audio/Audiobook).
 */
export const AUDIOBOOK_CATEGORIES = [3030] as const;
/** The qBittorrent category every audiobook grab is tagged with. */
export const AUDIOBOOKS_QB_CATEGORY = "torhq-audiobooks";

/** Best first: one m4b file beats a folder of mp3s; unknown ranks last. */
export const AUDIO_FORMATS = ["m4b", "m4a", "mp3", "flac", "ogg"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

const FORMAT_RE = /(?<![a-z0-9])(m4b|m4a|mp3|flac|ogg)(?![a-z0-9])/gi;

export function detectAudioFormat(title: string): AudioFormat | null {
  let best = -1;
  let found: AudioFormat | null = null;
  for (const m of title.matchAll(FORMAT_RE)) {
    const f = m[1]!.toLowerCase() as AudioFormat;
    const rank = AUDIO_FORMATS.indexOf(f);
    if (best === -1 || rank < best) { best = rank; found = f; }
  }
  return found;
}

export interface RankedAudiobookRelease {
  guid: string; indexerId: number; indexer: string; title: string;
  size: number | null; seeders: number | null; leechers: number | null; publishDate: string | null;
  infoUrl?: string; magnetUrl?: string; downloadUrl?: string;
  format: AudioFormat | null;
  matches: boolean;
  alive: boolean;
}

/** Matches the title, then seeded, then m4b > m4a > mp3 > flac > ogg > unknown, then seeders. Usenet is dropped. */
export function rankAudiobookReleases(releases: ProwlarrRelease[], want: { title: string }): RankedAudiobookRelease[] {
  const rank = (f: AudioFormat | null) => (f === null ? AUDIO_FORMATS.length : AUDIO_FORMATS.indexOf(f));
  return releases
    .filter((r) => r.protocol === "torrent")
    .map((r): RankedAudiobookRelease => ({
      guid: r.guid, indexerId: r.indexerId, indexer: r.indexer, title: r.title,
      size: r.size, seeders: r.seeders, leechers: r.leechers, publishDate: r.publishDate,
      ...(r.infoUrl ? { infoUrl: r.infoUrl } : {}),
      ...(r.magnetUrl ? { magnetUrl: r.magnetUrl } : {}),
      ...(r.downloadUrl ? { downloadUrl: r.downloadUrl } : {}),
      format: detectAudioFormat(r.title),
      matches: titleMatches(r.title, want.title),
      alive: (r.seeders ?? 0) > 0,
    }))
    .sort((a, b) =>
      Number(b.matches) - Number(a.matches)
      || Number(b.alive) - Number(a.alive)
      || rank(a.format) - rank(b.format)
      || (b.seeders ?? -1) - (a.seeders ?? -1));
}

export function bestAudiobookRelease(ranked: RankedAudiobookRelease[]): RankedAudiobookRelease | null {
  const top = ranked[0];
  return top && top.matches && top.alive ? top : null;
}
