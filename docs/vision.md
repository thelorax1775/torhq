# TorHQ vision

This is the product definition. When a card, a PR or the README disagrees with it,
this file wins; change it deliberately, not as a side effect.

## What TorHQ is

**One search-and-add hub for all media.** Think Overseerr/Jellyseerr, but for
everything the homelab holds: movies, TV, music, games, books, comics/manga and
audiobooks. You search once, pick the thing, and TorHQ routes it to the app that
owns that kind of media, then shows its progress all the way to "ready to watch /
read / listen" without opening another web UI.

The experience comes first. Adding something should take seconds and feel the same
for every kind of media:

1. **Search once.** One search box, on the home page, across every kind. Filter
   chips narrow it (Movies, TV, Music, Games, Books, Audiobooks) but are never
   required.
2. **See what it is and whether you have it.** Each result shows artwork, year,
   kind, and a status badge: *Available*, *Requested*, *Downloading*, *Missing*,
   or nothing.
3. **One obvious action.** A detail sheet with a single primary button
   (*Add*, or *Request* for a member account). Advanced choices (quality
   profile, root folder, picking a specific release) are tucked behind
   "Options", prefilled with sensible saved defaults.
4. **Watch it arrive.** One Activity view tracks each item through
   requested -> searching -> downloading -> importing -> available, merging what
   used to be split across Downloads, Queue and Jobs. When something stalls it
   says why in plain words and offers the fix.

Discovery (trending/popular browsing, today's Catalogue) feeds the same detail
sheet and the same action.

## Who owns what (routing)

| Kind | Metadata | Owner app (adds, grabs, imports, files) | Plays/reads in |
| --- | --- | --- | --- |
| Movies | TMDB / Radarr lookup | Radarr | Jellyfin |
| TV | TMDB / Sonarr lookup | Sonarr | Jellyfin |
| Music | Lidarr lookup (MusicBrainz) | Lidarr (slskd as manual fallback) | Navidrome |
| Books (ebooks) | Open Library | TorHQ intake (Prowlarr grab -> previewed import) | Calibre-Web / Kavita |
| Comics, manga | Open Library / filename | TorHQ intake | Kavita |
| Audiobooks | Open Library / Audiobookshelf | TorHQ intake (Prowlarr grab -> previewed import) | Audiobookshelf |
| Games | RAWG | Prowlarr grab into `torhq-games` (no importer) | n/a |

## The boundary (kept, deliberately)

TorHQ **never moves, renames or reorganises media owned by an \*arr app**.
Radarr, Sonarr and Lidarr own search, grab, import, rename and placement of what
they manage; TorHQ asks them through their APIs. For kinds with no \*arr (books,
comics, audiobooks), TorHQ's own intake does the import, and it stays
previewed and confined to `TORHQ_APPROVED_ROOTS`. Streamlining the UI may make the
preview faster to approve (one click, sensible defaults); it must not remove it.

## Users

The admin (the operator) sees everything. Friends get member accounts: they
search, request and watch progress; they never see Services, Settings, raw search
or the filesystem. A member's home page is the same search hub.

## Design principles

- The common path needs no configuration knowledge: no root folders, quality
  profiles or categories on the default path.
- Same layout and words for every media kind; the differences live in routing,
  not in the UI.
- Works well on a phone.
- Never a dead end: an unavailable backend shows why and what to do.
