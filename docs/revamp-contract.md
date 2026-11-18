# Revamp API contract

The contract the revamp workstreams build against. Server routes are the source
of truth; this file exists so the SPA and the backend can be written in
parallel. All `/api/*` routes require a session; every mutating route also
requires the `X-CSRF-Token` header. Errors are `{ "error": string }` with a
meaningful status (409 = service not configured, 502 = upstream failed).

---

## 1. Search — `server/src/routes/search.ts`

TorHQ searches three independent sources. The UI presents them as tabs; the
backend keeps them as one route family with a `source` discriminator.

### `GET /api/search/sources`

```jsonc
{ "sources": [
  { "id": "prowlarr", "label": "Prowlarr", "available": true,  "detail": "12 indexers" },
  { "id": "site",     "label": "Torrent site", "available": false, "detail": "Cloudflare challenge unsolved" },
  { "id": "web",      "label": "Web",      "available": true,  "detail": "link" }
] }
```

`available: false` never means "hidden" — the UI shows the source disabled with
`detail` as the reason.

### `GET /api/search?source=prowlarr&q=<term>&indexerIds=1,2&categories=2000,5000&limit=100`

```jsonc
{ "source": "prowlarr", "results": [{
  "guid": "…",            // opaque; required to grab
  "indexerId": 3,
  "indexer": "1337x",
  "title": "…",
  "size": 8589934592,      // bytes
  "seeders": 42,
  "leechers": 3,
  "protocol": "torrent",   // torrent | usenet
  "publishDate": "2026-07-20T10:00:00Z",
  "categories": [{ "id": 2000, "name": "Movies" }],
  "infoUrl": "https://…",  // optional detail page
  "magnetUrl": "magnet:?…" // optional; may be absent (grab by guid instead)
}] }
```

Sorted seeders-desc by default. `GET /api/search/indexers` returns
`{ indexers: [{ id, name, enable, protocol, categories }] }` for the filter UI.

### `GET /api/search?source=site&q=<term>&page=1`

Unchanged scraper shape: `{ source: "site", results: [{ title, magnet, size,
seeders, leechers, detailUrl }] }`. Kept as a fallback, not the primary path.

### `GET /api/search?source=web&q=<term>`

```jsonc
{ "source": "web", "provider": "link",
  "results": [{ "title": "…", "url": "https://…", "displayUrl": "example.com", "snippet": "…" }],
  "links":   [{ "label": "Google", "url": "https://www.google.com/search?q=…" }],
  "degraded": "Google API quota exceeded — showing links only" }
```

`results` is inline-renderable and empty for the `link` provider; `links` is
always populated so the widget is never dead. **Never scrape google.com/search.**

### `POST /api/search/grab`

```jsonc
{ "source": "prowlarr",       // prowlarr | site | web(never) 
  "guid": "…", "indexerId": 3, // prowlarr grabs
  "magnet": "magnet:?…",       // site grabs
  "title": "…",
  "target": "radarr"           // qbittorrent | radarr | sonarr | lidarr
}
```

Response: `{ ok: true, via: "prowlarr" | "qbittorrent", category: "radarr",
importTriggered: true }`.

Grab routing, in order of preference:
1. `source=prowlarr` + `target` is an *arr → hand the release to that *arr's own
   grab path so the *arr owns the download end to end.
2. `source=prowlarr` + `target=qbittorrent` → resolve the release to a magnet /
   `.torrent` and add it to qBittorrent under `torhq-manual`.
3. `source=site` → magnet straight to qBittorrent under the target's category,
   then `RefreshMonitoredDownloads` on that *arr (existing behaviour).

Magnets stay validated against the existing strict `magnet:?xt=urn:btih:` regex,
and categories stay on the fixed allowlist.

---

## 2. Downloads + queue — `server/src/routes/downloads.ts`

### `GET /api/downloads`

```jsonc
{ "torrents": [{ "hash": "…", "name": "…", "category": "radarr", "state": "downloading",
                 "progress": 0.42, "dlspeed": 1048576, "upspeed": 0, "size": 8589934592,
                 "eta": 3600, "savePath": "/downloads/radarr", "ratio": 0.1,
                 "addedOn": 1784950000, "tags": [] }],
  "transfer": { "dlspeed": 1048576, "upspeed": 65536 },
  "categories": { "radarr": { "name": "radarr", "savePath": "/downloads/radarr" } } }
```

### `POST /api/downloads/action`

```jsonc
{ "hashes": ["…"], "action": "pause", "category": "radarr" }
```

`action` ∈ `pause | resume | recheck | delete | deleteWithFiles | topPriority |
bottomPriority | setCategory`. `category` required for `setCategory` and
restricted to the existing allowlist plus categories qBittorrent already has.
`deleteWithFiles` is the only destructive action; it must be explicit in the UI
(typed confirmation) and logged to `activity`.

### `GET /api/queue`

The *arr side of the same pipeline — merged Radarr/Sonarr/Lidarr queues:

```jsonc
{ "items": [{ "service": "radarr", "id": 12, "title": "…", "status": "downloading",
              "trackedDownloadStatus": "warning", "trackedDownloadState": "importPending",
              "errorMessage": "…", "statusMessages": ["…"],
              "size": 8589934592, "sizeleft": 0, "downloadId": "ABCDEF…",
              "outputPath": "/downloads/radarr/…" }],
  "unavailable": [{ "service": "lidarr", "detail": "not configured" }] }
```

`POST /api/queue/refresh` fires `RefreshMonitoredDownloads` on every configured
*arr. `POST /api/queue/:service/:id/remove` takes
`{ removeFromClient: boolean, blocklist: boolean }`.

---

## 3. Pipeline health — `server/src/routes/pipeline.ts`

The answer to "why didn't my download get imported?", checked rather than
assumed.

### `GET /api/pipeline/check`

```jsonc
{ "checks": [{
  "id": "qb-category-radarr",
  "label": "qBittorrent has a `radarr` category",
  "ok": false,
  "severity": "error",          // error | warn | info
  "detail": "No category named radarr; grabs tagged radarr will not be adopted.",
  "fix": "Create it on the Downloads page, or set it in Radarr's download-client settings."
}] }
```

Checks to implement:
- each *arr is reachable and has qBittorrent configured as a download client;
- the download client's category in the *arr matches a category that exists in
  qBittorrent;
- Completed Download Handling is enabled in each *arr;
- the *arr's root folder is writable and not inside qBittorrent's save path;
- items sitting in the *arr queue in `importPending` / `importBlocked` for over
  an hour (surfaced as a warning with the count).

### `GET /api/pipeline/failed-imports`

`{ "items": [{ service, id, title, path, reason, downloadId }] }` — the *arr
queue records whose tracked state needs a manual import.

### `POST /api/pipeline/manual-import`

`{ service, downloadId }` → asks that *arr to re-scan/import the completed
download it already owns. TorHQ never moves the files itself.

---

## 3b. Hub search — `server/src/routes/hub.ts`, `server/src/lib/hub.ts`

One search across every media kind, and the detail behind a result. Read-only,
`requireAuth` only: **admin and member** both may call it. Nothing here adds,
grabs or moves anything; adding stays with the owner app (docs/vision.md,
"Who owns what").

### `GET /api/hub/search?q=<term>&kinds=movie,tv,music,game,book,audiobook`

`q` is required (1-256 chars). `kinds` is optional (omitted = all six); an
unknown kind is a 400.

```jsonc
{
  "results": [{
    "kind": "movie",             // movie | tv | music | game | book | audiobook
    "id": "tmdb:693134",         // pass back to /api/hub/item. tmdb:N movie, tvdb:N tv, mbid:X music,
                                 // RAWG id game, Open Library work id (OL…W) book/audiobook
    "title": "Dune: Part Two", "year": 2024, "subtitle": "Legendary", "poster": "https://…",
    "overview": "…",
    "status": "available",       // available | requested | downloading | missing | none | unknown
    "owner": "radarr",           // radarr | sonarr | lidarr | intake | prowlarr
    "actionable": false          // owner can take it and it is not already held/on its way
  }],
  "sources": [{ "kind": "movie", "available": true },
              { "kind": "book", "available": false, "detail": "timed out after 6s" }]
}
```

- Each kind is queried **in parallel** with a per-source timeout (6 s). A slow,
  unconfigured or failing source yields `sources[].available=false` with a short
  human reason and never fails the request (it is always 200). `detail` never
  contains URLs, hosts, keys or upstream bodies.
- `results` is interleaved round-robin across kinds in the order movie, tv,
  music, game, book, audiobook (each kind keeps its source's own relevance
  order, max 8 per kind), so no kind buries the rest. `sources` has one row per
  requested kind, in that canonical order.
- **Status** comes from the owning app: a lookup hit with a library id is in the
  library; with files = `available`; monitored and no files = `requested`;
  unmonitored and no files = `missing`; in the *arr's queue = `downloading`;
  not in the library = `none`. Movie/tv/music use Radarr/Sonarr/Lidarr. If the
  *arr is not configured, movie/tv fall back to TMDB metadata with
  `status: "unknown"`. Games (RAWG) and books/audiobooks (Open Library) are
  `unknown` until a backend can say what is held; books/audiobooks are also
  `actionable: false` until a book grab path exists. File state is read from the
  title's own library record (`/movie/{id}`, `/series/{id}`, `/artist/{id}`),
  because `/lookup` does not report it. A TMDB-only show has no TVDB
  id, so it is `actionable: false`.

### `GET /api/hub/item?kind=<kind>&id=<id>`

Detail for the sheet: `{ "item": { …the result fields…, "backdrop", "genres",
"libraryId" (the *arr's id when held), "seasons" (tv), "albums" (music, when in
the library), "addOptions" } }`.

`addOptions` is what the server would use for a one-click add:
`{ service, qualityProfileId, metadataProfileId (lidarr), rootFolderPath, monitored, searchNow, basis }`.
`basis` is `saved` (the *arr's saved defaults), `arr-first` (the *arr's first
profile/root folder) or `none`. **`rootFolderPath` is returned to admins only.**
Errors: 400 bad id for the kind, 404 not found, 409 owner app not configured,
502 source failed/timed out.

### One-click add (used by the home page)

- `POST /api/acquire/auto-search` — **admin only** (`requireAdmin`, CSRF).
  `{ service: "radarr"|"sonarr"|"lidarr", id }` (the library id `prepare`
  returned) → `{ ok, service, command }`. Posts the *arr's own
  `MoviesSearch` / `SeriesSearch` / `ArtistSearch` command: the *arr searches
  and grabs by itself. TorHQ never lists or picks a release here. 409 when the
  service is not configured, 502 when the *arr refuses.
- `POST /api/requests/:route` (member allowed) — `rootFolderPath` and
  `qualityProfileId` are now **optional**. Omitted, the saved defaults apply,
  then the *arr's first root folder/quality profile (and first metadata profile
  for Lidarr), so a member never has to know a server path.

---

## 4. SPA — `web/`

React 18 + Vite + `react-router-dom` v6 (already in `web/package.json` and the
lockfile — **do not add other dependencies**). Single origin, session cookie,
CSRF header via the existing `web/src/lib/api.ts` helper.

Routes: `/` search hub (admin and member), `/dashboard` (admin), `/search` (raw search), `/downloads`, `/queue`, `/requests`,
`/intake`, `/jobs`, `/libraries`, `/mounts`, `/services`, `/settings`.
Deep links must work on reload — the server already falls back to `index.html`
for non-`/api` paths.

Required foundations:
- **Design tokens** in one stylesheet: colour, spacing, radius, type scale.
  Dark-first, light via `prefers-color-scheme`. No CSS framework.
- **Shared data layer**: one `usePolled(path, intervalMs)` hook with in-flight
  dedupe, visibility-aware pausing (no polling in a hidden tab), and a shared
  error/stale surface. Pages must not hand-roll `useEffect` + `fetch`.
- **Layout**: persistent sidebar + header, mobile-collapsible, keyboard reachable.
- Every destructive action confirms; every async action shows pending state.
