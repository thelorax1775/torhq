import type { ProwlarrRelease } from "../adapters/prowlarr.js";

/**
 * Book release ranking. Pure functions, no I/O: the route feeds in Prowlarr's
 * results and gets back the order a person should see them in.
 *
 * Prowlarr's book categories (newznab): 7000 Books, 7020 Books/EBook,
 * 8000 Other. 8000 is noisy but is where several indexers file ebooks, so it is
 * searched too and simply ranks below anything with a recognisable format.
 */
export const BOOK_CATEGORIES = [7000, 7020, 8000] as const;
/** The qBittorrent category every book grab is tagged with. */
export const BOOKS_QB_CATEGORY = "torhq-books";

/** Best first. Anything not listed ranks after all of these. */
export const BOOK_FORMATS = ["epub", "azw3", "mobi", "pdf"] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

const FORMAT_RE = /(?<![a-z0-9])(epub|azw3|mobi|pdf)(?![a-z0-9])/gi;

/** The best format a release title advertises (a pack of "EPUB MOBI PDF" is an epub). */
export function detectFormat(title: string): BookFormat | null {
  let best = -1;
  let found: BookFormat | null = null;
  for (const m of title.matchAll(FORMAT_RE)) {
    const f = m[1]!.toLowerCase() as BookFormat;
    const rank = BOOK_FORMATS.indexOf(f);
    if (best === -1 || rank < best) { best = rank; found = f; }
  }
  return found;
}

const STOP = new Set(["a", "an", "the", "of", "and"]);
function tokens(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t && !STOP.has(t));
}

/** Every significant word of the title appears in the release name. */
export function titleMatches(releaseTitle: string, title: string): boolean {
  const want = tokens(title);
  if (want.length === 0) return false;
  const have = new Set(tokens(releaseTitle));
  return want.every((t) => have.has(t));
}

export interface RankedBookRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  publishDate: string | null;
  infoUrl?: string;
  magnetUrl?: string;
  downloadUrl?: string;
  format: BookFormat | null;
  /** The release name contains the whole title. A release that does not is probably a different book. */
  matches: boolean;
  /** Seeded right now: a dead torrent never beats a live one, whatever its format. */
  alive: boolean;
}

/**
 * Order: releases that match the title, then ones someone is seeding, then
 * epub > azw3 > mobi > pdf > unknown, then by seeders. Usenet results are
 * dropped: books go to qBittorrent.
 */
export function rankBookReleases(releases: ProwlarrRelease[], want: { title: string }): RankedBookRelease[] {
  const rank = (f: BookFormat | null) => (f === null ? BOOK_FORMATS.length : BOOK_FORMATS.indexOf(f));
  return releases
    .filter((r) => r.protocol === "torrent")
    .map((r): RankedBookRelease => ({
      guid: r.guid, indexerId: r.indexerId, indexer: r.indexer, title: r.title,
      size: r.size, seeders: r.seeders, leechers: r.leechers, publishDate: r.publishDate,
      ...(r.infoUrl ? { infoUrl: r.infoUrl } : {}),
      ...(r.magnetUrl ? { magnetUrl: r.magnetUrl } : {}),
      ...(r.downloadUrl ? { downloadUrl: r.downloadUrl } : {}),
      format: detectFormat(r.title),
      matches: titleMatches(r.title, want.title),
      alive: (r.seeders ?? 0) > 0,
    }))
    .sort((a, b) =>
      Number(b.matches) - Number(a.matches)
      || Number(b.alive) - Number(a.alive)
      || rank(a.format) - rank(b.format)
      || (b.seeders ?? -1) - (a.seeders ?? -1));
}

/** The release to pre-select for "accept best match", or null when nothing deserves it. */
export function bestBookRelease(ranked: RankedBookRelease[]): RankedBookRelease | null {
  const top = ranked[0];
  return top && top.matches && top.alive ? top : null;
}

/** The Prowlarr query for a book: title and author, with punctuation that indexers choke on removed. */
export function bookQuery(title: string, author?: string | null): string {
  return [title, author ?? ""].join(" ").replace(/[:'’"!?™®©]/g, "").replace(/\s+/g, " ").trim();
}
