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

Admin gets the full response below. A **member** gets the same shape with
`torrents: []` and `categories: {}` and the real `transfer` totals (the layout's
speed readout), so no save/content path leaves the server.

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

### `GET /api/activity`

`requireAuth`. The one list behind the Activity page; newest first.

```jsonc
{ "items": [{ "id": "radarr:7", "kind": "movie", "title": "Dune: Part Two", "artwork": "https://…",
              "stage": "importing",            // requested | searching | downloading | importing | available
              "status": "stalled",             // active | stalled | done
              "progress": 100, "etaSeconds": null, "startedAt": 1794980000000, "requestedBy": "sam",
              "source": "arr",                 // arr | torrent | slskd | job
              "stall": { "reason": "…", "fix": "…", "detail": "the *arr's own message (admin only)" },
              "href": "/queue" }],             // admin only
  "unavailable": [{ "source": "radarr", "detail": "…" }] }   // admin only
```

Admin: everything, including raw qBittorrent/slskd downloads and intake jobs the
*arr do not know about. Member: their own requests, plus other people's *in-flight*
items as generic progress (no requester, no `href`, no `detail`, and a stall `fix`
that never points at an admin page). Stalls come from the *arr queue state, the
download client and, for admins, the failing pipeline checks. Read-only.
`?limit` is 1-500 (400 otherwise). `GET /api/activity/log` is the raw audit log
that used to live at this path; it is admin-only.

### `GET /api/jobs`, `GET /api/jobs/:id`

**Admin only** (`requireAdmin`; 403 for a member): jobs carry `sourcePath`,
`payloadJson` and `lastError`. `POST /api/jobs/:id/retry` was already admin-only.

### `GET /api/queue`

**Admin only** (`requireAdmin`; 403 for a member): items carry `outputPath`.

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
  `unknown` until a backend can say what is held. **Books** are answered by Kavita
  (`/api/Search/search`) and Calibre-Web (OPDS search) when configured, plus
  TorHQ's own wanted record (requested/downloading/available); a book is
  `actionable` only when Prowlarr and qBittorrent are configured and it is not
  held or on its way. **Audiobooks** are answered the same way by Audiobookshelf
  (`POST /api/libraries/{id}/search`) and TorHQ's own record (kind `audiobook`);
  see 3d. File state is read from the
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
- `GET /api/requests/:route/options` — members get `profiles` and
  `metadataProfiles`; `roots` is `[]` for a member, the *arr's root folders for an
  admin.
- `POST /api/requests/:route` (member allowed) — a **member** who sends
  `rootFolderPath` gets 400 ("Members cannot choose the folder") and nothing
  reaches the *arr. An **admin's** `rootFolderPath` must equal one of the *arr's
  `rootFolders()` paths, else 400 and nothing is added. `rootFolderPath` and
  `qualityProfileId` are **optional**. Omitted, the saved defaults apply,
  then the *arr's first root folder/quality profile (and first metadata profile
  for Lidarr), so a member never has to know a server path.

---

## 3c. Books — `server/src/routes/books.ts`, `lib/books.ts`, `lib/wanted.ts`

The one kind with no *arr: TorHQ's own intake imports it (docs/vision.md). A
`wanted_items` row follows a title `requested -> grabbed -> ready -> importing ->
imported` (or `failed` / `declined`). qBittorrent category: `torhq-books`.

| Route | Access | Notes |
| --- | --- | --- |
| `POST /api/books/request` | any user + CSRF | `{ title, author?, externalId? (OL…W) }`. Duplicate (same work id or title+author) returns `{ existing: true }` and the existing item. |
| `GET /api/books/wanted` | any user | Admin: all items, with `releaseTitle`, `error`, `jobId` and the intake `preview` (paths). Member: only their own, `id/title/author/status/…` with **no paths**. An admin read also advances finished downloads to `ready`. |
| `GET /api/books/status` | **admin** | `{ prowlarr, qbittorrent, category, categoryExists, library, ready, problems[] }` |
| `POST /api/books/wanted/:id/search` | **admin** + CSRF | Prowlarr search, categories `7000,7020,8000`, query = title + author. Returns `{ query, releases[] (format, matches, alive), bestGuid }` ranked epub > azw3 > mobi > pdf, then seeders; usenet dropped. |
| `POST /api/books/wanted/:id/grab` | **admin** + CSRF | `{ guid, indexerId, title, magnet? \| downloadUrl? }`; adds to qBittorrent category `torhq-books` with tag `torhq-wanted-<id>`. Magnets are validated; Prowlarr download URLs are origin-checked. |
| `POST /api/books/wanted/:id/approve` | **admin** + CSRF | Only valid in `ready`. Re-runs the dry run, then queues the normal `manual_intake` job (idempotency key `wanted:<id>`). **The only call that causes a file move.** 409 otherwise. |
| `POST /api/books/wanted/:id/decline` | **admin** + CSRF | Marks the request declined. |

When a tagged torrent finishes, TorHQ calls `previewIntake` (approved roots,
symlink checks) against the first library with `kind: books` and `targetService:
kavita`; the stored preview is what the admin approves. A source outside the
approved roots never gets a preview; the item stays `grabbed` with the reason in
`error`.

New service kind `calibreweb` (secret `username:password`, OPDS): `health` and
library title search only. Calibre-Web has no safe ingest path, so it is never an
intake target.


---

## 3d. Audiobooks — second flow in `server/src/routes/books.ts`, `lib/audiobooks.ts`, `adapters/audiobookshelf.ts`

The same routes and state machine as 3c, mounted under `/api/audiobooks/*`, with
`wanted_items.kind = "audiobook"`. Every `:id` route 404s for an item of the other
kind. Access levels are identical to 3c: request/list are any user (request needs
CSRF); `status`, `search`, `grab`, `approve`, `decline` are **admin**.

| Route | Access |
| --- | --- |
| `POST /api/audiobooks/request` | any user + CSRF |
| `GET /api/audiobooks/wanted` | any user (admin: all + preview; member: own, no paths) |
| `GET /api/audiobooks/status` | **admin** |
| `POST /api/audiobooks/wanted/:id/search` | **admin** + CSRF. Prowlarr category `3030`; ranked m4b > m4a > mp3 > flac > ogg, then seeders. |
| `POST /api/audiobooks/wanted/:id/grab` | **admin** + CSRF. qBittorrent category `torhq-audiobooks`. |
| `POST /api/audiobooks/wanted/:id/approve` | **admin** + CSRF. Queues the previewed intake job; the worker then asks Audiobookshelf to scan. |
| `POST /api/audiobooks/wanted/:id/decline` | **admin** + CSRF |

Completion builds the preview against the first library with `kind: audiobooks`
and `targetService: audiobookshelf`. The intake payload gains an optional
`destSubdir` (`Author`, or `Author/Title` for a lone file); each segment is
sanitised and the composed destination re-validated against the approved roots.
`GET /api/hub/search?kinds=audiobook` reports `available` from ABS's library
search, otherwise from the wanted record; `actionable` needs Prowlarr and qBittorrent.

New service kind `audiobookshelf` (secret = API token, sent as `Bearer`; extra
`{ libraryId? }`). `health` is `POST /api/authorize`; the adapter lists libraries,
searches one, and triggers `POST /api/libraries/{id}/scan`. Libraries accept
`kind: audiobooks` / `targetService: audiobookshelf`.

---

## 3e. Requests waiting for the admin — `pendingRoutes` in `server/src/routes/books.ts`

Backs Activity's **Requests** tab and the admin nav badges. Movie, TV and music
requests go straight to Radarr/Sonarr/Lidarr (which search by themselves), so the
only member requests that wait for the admin are books and audiobooks in
`requested`. All four routes are **admin** (a member gets 403).

| Route | Access | Notes |
| --- | --- | --- |
| `GET /api/requests/pending` | **admin** | `{ items: [{ id, kind (book\|audiobook), title, author, externalId, requestedBy, createdAt }] }`, newest first. No paths. |
| `POST /api/requests/pending/:id/approve` | **admin** + CSRF | Searches Prowlarr exactly like `…/wanted/:id/search` and grabs the best-ranked release like `…/wanted/:id/grab`. `{ ok, release, item }`. 409 when the item is no longer `requested`, when Prowlarr/qBittorrent is not configured, or when no release matches the title with seeders (nothing is grabbed; choose one on the Books/Audiobooks page). |
| `POST /api/requests/pending/:id/decline` | **admin** + CSRF | Marks it `declined`. 409 when it is no longer `requested`. |
| `GET /api/attention` | **admin** | `{ requests, imports }`: requests waiting (above) and book/audiobook downloads in `ready` (waiting on *Imports to approve*). Polled by the nav for its badges. |

---

## 4. SPA — `web/`

React 18 + Vite + `react-router-dom` v6 (already in `web/package.json` and the
lockfile — **do not add other dependencies**). Single origin, session cookie,
CSRF header via the existing `web/src/lib/api.ts` helper.

Routes: `/` search hub (admin and member), `/discover`, `/activity` (admin: `?view=requests`
opens the Requests tab, `?item=<id>` highlights one row), and for the admin `/transfers`,
`/history`, `/imports`, `/libraries`, `/mounts`, `/services`, `/settings`, `/users`;
`/search` (raw indexer search, linked from the bottom of hub results), `/dashboard`, `/books`
and `/audiobooks` stay routed but are not in the nav. Old URLs redirect: `/get` -> `/`,
`/requests` -> `/activity?view=requests` (a member: `/activity`), `/downloads` and `/queue`
-> `/transfers`, `/jobs` -> `/history`, `/intake` -> `/imports`, `/catalogue` -> `/discover`.
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
