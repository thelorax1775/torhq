# TorHQ

TorHQ is **one search-and-add hub for all your media** — movies, TV, music,
games, books, comics and audiobooks. Search once, pick the thing, and TorHQ sends
it to the app that owns that kind of media (Radarr, Sonarr, Lidarr, or its own
previewed intake into Calibre-Web, Kavita and Audiobookshelf), then shows its
progress until it is ready to watch, read or listen to — without opening another
web UI. Friends get member accounts to search and request the same way.

Behind the hub it is also the control plane for the stack it sits in front of:
service health, downloads (qBittorrent, slskd), queues, and plain-language reasons
when an import stalls. The product definition lives in
[`docs/vision.md`](docs/vision.md). The pages, and what each is for, are under
[Using TorHQ](#using-torhq).

> **The core boundary.** TorHQ **never moves, renames, or reorganizes media owned
> by the \*arr applications.** Radarr/Sonarr/Lidarr own search, grab, import,
> rename, and final placement of everything they manage. TorHQ only performs its
> own explicit, previewed, approved **manual-intake** action, and every filesystem
> operation is confined to the directories listed in `TORHQ_APPROVED_ROOTS`.

---

## Table of contents

- [What TorHQ does](#what-torhq-does)
- [Architecture](#architecture)
- [The intake boundary](#the-intake-boundary-torhq-vs-the-arr)
- [Discover: browse movies, TV and games](#discover-browse-movies-tv-and-games)
- [Choosing a specific release](#choosing-a-specific-release)
- [Identifying raw releases](#identifying-raw-releases)
- [Search, grab, and the import loop](#search-grab-and-the-import-loop)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [First-run setup](#first-run-setup)
- [Using TorHQ](#using-torhq)
- [Production deployment (LXC)](#production-deployment-lxc)
- [Backup & restore](#backup--restore)
- [Security model](#security-model)
- [API](#api)
- [Project layout](#project-layout)
- [Project status](#project-status)

---

## What TorHQ does

| Area | Capability |
| --- | --- |
| **Search** | The home page. One search box over movies, TV, music, games and books, with kind filter chips, artwork and a status badge per result. A detail sheet has one primary button: *Add* (admin) or *Request* (member). |
| **Dashboard** | Aggregated service health, qBittorrent downloads grouped by category, \*arr activity (history + wanted/missing), slskd downloads, storage usage, and failed-import surfacing. |
| **Identify** | Raw search results are put through Radarr, Sonarr and Lidarr's **own parsers** — the same ones that perform imports — so a release row says what it is and offers to route it to the \*arr that will file it. **Gemini** (optional) handles only the names those parsers cannot read. |
| **Discover** | Browse what's trending, popular, top rated and upcoming — movies and TV from **TMDB**, games from **RAWG** — with genre and platform filters, and the titles already in Radarr/Sonarr marked. Opening a title shows the same detail sheet and single action (*Add* / *Request*) as Search. |
| **Choose release** | In the Search detail sheet (admin, under *Options*): add the title to its \*arr without a search, pick a TV season or an album, then choose from that \*arr's **own interactive search** (with its quality scoring and rejection reasons); the \*arr grabs, imports and files it. |
| **Activity** | Every request followed to *Available*, with stall reasons in plain words. Admins also get a **Requests** tab to approve or decline what friends asked for. |
| **Search indexers** | Raw search, reached from the bottom of Search results: **Prowlarr** (every indexer), a scraped **torrent-index site**, and a **web widget**. Grab into a neutral `torhq-manual` category, or hand it to `radarr`/`sonarr`/`lidarr` so that \*arr adopts and imports it. |
| **Transfers** | One table of what qBittorrent, Soulseek and the Radarr/Sonarr/Lidarr queues are doing right now, with pause/resume and removal (deleting files needs a typed confirmation), and anything that will stop an import listed above it. One dead service degrades to a notice; it never blanks the view. |
| **Pipeline health** | Read-only checks of the grab → download → import path: does the \*arr have a download client, do its categories match, can it actually see the directory qBittorrent writes to. Each failing check names the fix — TorHQ never applies one silently. |
| **Manual intake** | Preview and then atomically import a completed file/folder into a **Kavita** (books/manga/comics), **Audiobookshelf** (audiobooks) or **Navidrome** (music) library, then trigger a rescan. Per library, either moves the source in or **hardlinks** it so a seeding torrent is left intact. Durable, idempotent, retried. |
| **slskd webhook** | Completed Soulseek downloads are pushed to `/webhooks/slskd` (shared-token auth) and enqueued as intake jobs into a music library. |
| **Services** | Encrypted-at-rest credential storage with a connection tester. Secrets are never returned to the browser. |

---

## Architecture

TorHQ is a TypeScript monorepo (npm workspaces, Node 22; Node 20 still works).

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  web  (React + Vite SPA)    │  fetch │  server  (Fastify)               │
│  session cookie + CSRF hdr  │ ─────▶ │  ┌────────────────────────────┐  │
└─────────────────────────────┘        │  │ auth  session + CSRF       │  │
        served as static files         │  │ routes  REST + webhooks    │  │
        by the server in prod          │  │ adapters  service HTTP     │  │
                                        │  │ queue  durable intake jobs │  │
                                        │  │ security  path containment │  │
                                        │  └────────────────────────────┘  │
                                        │  SQLite (better-sqlite3 + Drizzle)│
                                        └──────────────────────────────────┘
                                                     │  outbound HTTP
                     ┌───────────────────────────────┼───────────────────────────────┐
                 Radarr/Sonarr/Lidarr   Prowlarr  qBittorrent  slskd   Jellyfin/Navidrome/Kavita
```

- **Backend** — Fastify 4 with `@fastify/cookie`, `@fastify/rate-limit`, and
  `@fastify/static`. Data lives in SQLite via `better-sqlite3` with a Drizzle
  schema. Service credentials are encrypted at rest (AES-256-GCM). A single
  in-process worker drains a durable, SQLite-backed job queue.
- **Frontend** — React 18 + Vite single-page app. In production the server serves
  the built assets from `web/dist` on the same origin (no CORS), so the session
  cookie and CSRF token cover the whole app.
- **Adapters** — one small typed HTTP client per service, all implementing a
  common `ServiceAdapter` health contract, constructed on demand from the
  decrypted, per-service config.
- **Portability** — the schema avoids SQLite-only tricks (epoch-ms integer
  timestamps, JSON stored as text) so it can move to Postgres later.

### Data model

| Table | Purpose |
| --- | --- |
| `users` | Admin and member accounts (scrypt password hash, role). |
| `sessions` | Server-side sessions with a per-session CSRF token. |
| `services` | One row per configured service; secret **encrypted**, adapter config as JSON. |
| `libraries` | Manual-intake destinations (Kavita/Navidrome) with dest + staging paths. |
| `jobs` | Durable intake queue: status, attempts, backoff, idempotency key. |
| `activity` | Append-only audit/activity timeline for jobs and requests. |
| `schema_migrations` | Applied forward-only migration versions. |

---

## The intake boundary (TorHQ vs. the \*arr)

This is the most important thing to understand about TorHQ.

**\*arr-owned media (movies, TV, \*arr-managed music).**
Radarr, Sonarr, and Lidarr fully own their download → import → rename → placement
pipeline. TorHQ's role is limited to **requesting** an add+search through their
APIs. TorHQ never reads, moves, renames, or deletes files that an \*arr manages,
and it never writes into an \*arr root folder. Doing so would corrupt the \*arr's
own bookkeeping and hard-linking.

**TorHQ-owned intake (loose books, manga, comics, Soulseek music).**
Some content has no \*arr. For those, TorHQ offers a manual-intake pipeline that
is explicit and previewed end-to-end:

1. You (or the slskd webhook) name a **source path** inside an approved root.
2. TorHQ builds a **dry-run preview**: it validates containment, rejects symlink
   escapes, and lists exactly what will be imported. Symlinks inside the source are
   never imported: the preview names each one ("Skipping symlink: <relative path>",
   up to 20, then "and N more") and the import neither copies nor recreates them,
   in move and link mode alike.
3. On approval, a durable job **atomically imports** the content into the
   library's destination via a same-filesystem staging directory, then requests a
   **rescan** of the target service (Kavita or Navidrome).

Each library chooses **how** step 3 gets the bytes across:

| Import mode | What happens | Use it when |
|---|---|---|
| **Move** (default) | Copies the source into staging, reveals it atomically, then **deletes the source**. | The source is a scratch drop directory you want emptied. |
| **Hardlink** | Gives the files a second name inside the library. No bytes are read or written, no extra disk space is used, and **the source is left exactly as it was**. | The source is a torrent that is still seeding, or anything else you are not willing to lose. |

Hardlink mode is the same trick the \*arr use to import a completed download
without disturbing the torrent behind it. It requires the source and the library
to be on **one filesystem** — if they are not, the import fails with an
explanation rather than silently falling back to a copy-and-delete that would
break the seed.

**When the destination name is already taken.** An import is named after its
source folder (or the book's title), so a different item can already be sitting
at that name: two books with one title, or a better copy of one you hold. TorHQ
compares the two before doing anything:

- **Different files** (a file name, size or content differs): the import **fails** with
  a message naming the destination, and **nothing is deleted** — the download
  stays where it is and the library item is untouched. The preview warns about
  this before you approve. Import under another name, or move the existing item
  out of the library, then try again.
- **The same files with the same bytes** (names, sizes and contents all
  match; a hardlink to the same file counts): this is an import that already landed
  (a retry after a crash, or the same download imported twice). It finishes as
  "already present"; in move mode the now-duplicate source is deleted.
- **The source is already gone**: the earlier attempt finished; the job succeeds.

Manual-intake destinations may only target **Kavita**, **Audiobookshelf** or **Navidrome**. Jellyfin
(movies/TV) is intentionally *not* an intake target — that content is \*arr-owned.
TorHQ integrates with Jellyfin for health/status only.

Every path is checked with defense-in-depth containment (lexical `..` collapse,
prefix-aliasing-safe root check, and `realpath` symlink-escape rejection) against
`TORHQ_APPROVED_ROOTS`. A destination that does not exist yet is checked through
its nearest existing parent: if that parent is a symlink leading outside the
roots, the path is rejected. There are no destructive media operations beyond this one
previewed, approved import.

---

## Books (ebooks)

No \*arr manages books, so TorHQ's own intake does (see
[the intake boundary](#the-intake-boundary-torhq-vs-the-arr)). The flow, from the
**Books** page, or straight from the search hub (a book's detail sheet sends
*Request*; an admin lands on the release picker; a downloaded book shows
*Approve import* in the sheet and on **Imports to approve**):

1. **Search** a title or author (Open Library). Each result says whether you
   already hold it: Kavita's and Calibre-Web's own searches are asked, so a book
   in either shows *Available*.
2. **Request/Add.** A member's request waits for an admin; the admin sees every
   request and a member sees only their own, without any paths. A member never
   chooses the folder: a request that names `rootFolderPath` is refused with 400,
   and the *arr's saved default (then its first root) is used.
3. **Find a release.** TorHQ searches Prowlarr restricted to the book categories
   (7000 Books, 7020 Books/EBook, 8000 Other) with *title + author*, and ranks
   the results **epub > azw3 > mobi > pdf, then seeders**. Releases whose name
   lacks the title, or with no seeders, never outrank a real match. The best
   match is pre-selected; the admin accepts it or picks another.
4. **Grab.** The release goes to qBittorrent under the **`torhq-books`**
   category, tagged so TorHQ can find that exact torrent again.
5. **Preview, automatically.** When the download completes (checked every 30 s,
   and whenever an admin opens the page), TorHQ builds an intake **dry-run
   preview** against the books library. **Nothing is moved yet.**
6. **Approve.** One click on *Approve import* queues the normal intake job
   (previewed, confined to `TORHQ_APPROVED_ROOTS`, retried, logged under Jobs &
   activity). Grabbing a different release replaces the earlier one cleanly (the old torrent and preview are dropped). The item then shows *Available* once Kavita has it.

**Setup**

- **qBittorrent category.** TorHQ creates nothing in qBittorrent: the
  `torhq-books` category must already exist there (create it in qBittorrent's own
  UI or API) with a save path **inside an approved root**. That path must be the
  **same absolute path inside TorHQ's container** — TorHQ uses qBittorrent's
  `content_path` as-is, with no path mapping (e.g. `/mnt/storage-4tb-x2/torrents/torhq-books`,
  bind-mounted at that same path in both containers). If the content is outside
  the roots, the preview is refused and the item says so.
- **Books library.** On **Libraries**, add one with *kind* `books`, *target*
  Kavita, destination = the folder Kavita's Books library watches, staging on the
  same filesystem. *Move* deletes the finished download after import; *Hardlink*
  keeps it seeding. (Set Kavita's `libraryId` on its service to trigger a scan;
  otherwise Kavita's folder watcher picks it up.)
- **Services.** Prowlarr and qBittorrent are required. Kavita (already an intake
  target) and optionally **Calibre-Web** are used to answer "do we have it?".
  `GET /api/books/status` (admin) lists whatever is still missing.

**Calibre-Web: read-only, by design.** Calibre-Web reads a Calibre `metadata.db`
and a folder tree it owns, and has no watched ingest folder: the only supported
ways in are its UI upload or `calibredb add`, both of which rewrite
`metadata.db`. Copying files into that tree from outside leaves the database and
the disk out of step, so TorHQ does **not** import into Calibre-Web. Books go to
Kavita; the Calibre-Web adapter (Services → *Calibre-Web*, secret
`username:password`, OPDS enabled on that account) only reports health and
answers library searches over OPDS.

---

## Audiobooks (Audiobookshelf)

Audiobooks run the same flow as ebooks (request, Prowlarr grab, previewed
import, one-click approve), from the **Audiobooks** page or the search hub, and
land in **Audiobookshelf** (ABS). Differences from ebooks:

- **Search + status.** Open Library supplies the metadata; ABS's own library
  search says whether you already hold it (*Available*).
- **Release search.** Prowlarr category **3030** (Audio/Audiobook), title +
  author. Ranking: **m4b > m4a > mp3 > flac > ogg, then seeders**; a release
  without the title, or with no seeders, never outranks a real match.
- **Grab.** qBittorrent category **`torhq-audiobooks`**.
- **Layout.** The preview targets the ABS library folder as **Author/Title/**
  (a folder download becomes `Author/Title`; a lone file goes inside
  `Author/Title/`). Author and title are sanitised and the destination must stay
  inside `TORHQ_APPROVED_ROOTS`.
- **After approval.** The intake job moves the files, then asks ABS to scan the
  library; the item shows *Available* once ABS has it. Nothing moves, and ABS is
  not scanned, before the approval click.
- **Access.** Members can *Request* and see their own requests (no paths);
  search, grab, approve and decline are admin-only. The routes that carry server
  paths are closed to members: import jobs and the *arr queue answer 403,
  `/api/downloads` returns only the speed totals (no torrents, no save paths),
  and the request options return no root folders.

**Setup**

1. **Service.** Services → *Audiobookshelf*: base URL (e.g.
   `http://192.168.10.136:13378`) and an **API token** (ABS → Settings → API
   Keys; the token is encrypted at rest and shown masked). Optionally set the
   **library ID** to pin which ABS library is searched and scanned; blank uses
   the first book library. The health check is an authorised call, so a wrong
   token shows as unhealthy.
2. **Approved root.** Add the folder ABS's audiobook library watches, as TorHQ
   sees it, to `TORHQ_APPROVED_ROOTS` and restart TorHQ. Downloads and staging
   must be inside an approved root too.
3. **Library.** Libraries → add one with *kind* `audiobooks` (target is
   Audiobookshelf), destination = the ABS audiobook folder, staging on the same
   filesystem, *rescan* on.
4. **qBittorrent category.** TorHQ creates nothing in qBittorrent: the
   `torhq-audiobooks` category must already exist there (create it in
   qBittorrent's own UI or API) with a save path inside an approved root that is
   the **same absolute path inside TorHQ's container** (no path mapping;
   `content_path` is used as-is).
5. Prowlarr and qBittorrent are required. `GET /api/audiobooks/status` (admin)
   lists whatever is still missing.

---

## Unified search API (hub)

`GET /api/hub/search?q=&kinds=` searches movies, TV, music, games, books and
audiobooks at once (movies/TV/music through Radarr/Sonarr/Lidarr lookups, games
through RAWG, books and audiobooks through Open Library) and reports for each
result whether you already have it: available, requested, downloading, missing,
none, or unknown (games until a backend can say; books are answered by Kavita and Calibre-Web, audiobooks by Audiobookshelf, and both by TorHQ's own request record). `GET /api/hub/item`
returns the detail and default add options for one result. Both are open to
members as well as the admin and are read-only; a source that is down or slow
shows up under `sources` instead of failing the search. See
`docs/revamp-contract.md` section 3b.

## Discover: browse movies, TV and games

**Search** answers "I know what I want". **Discover** (`/discover`, formerly the
Catalogue) answers "what's worth getting?" — a poster grid of what's trending,
popular, top rated, in cinemas, on the air or coming soon, filterable by genre
(and, for games, by platform), with a title search on top.

Clicking a title opens **the same detail sheet as Search**, with the same one
action: *Add* for an admin, *Request* for a member, disabled with its reason when
the title is already available, requested or downloading. Discover has no
hand-offs of its own. The old `/catalogue` address redirects here, keeping any
filters in the link.

| Kind | Source | Notes |
| --- | --- | --- |
| Movies | [TMDB](https://www.themoviedb.org/settings/api) | TMDB ids are what Radarr keys on, so the title added is exact, not a title match. |
| TV | TMDB | Added through the TVDB id TMDB records for the show, so Sonarr owns it from there. A show with no TVDB id says so. |
| Games | [RAWG](https://rawg.io/apidocs) | Browse only. No \*arr manages games, so the sheet says adding them from here isn't set up; an admin can still grab one from **Search indexers** (the link under Search results). |

**Setup.** Both keys are free. Add them under **Services** as `tmdb` and `rawg`;
they are encrypted at rest like every other credential. TMDB issues two
credentials for one account — the short *API key* or the long *API Read Access
Token* — and either works. A kind whose key is missing is shown with the reason,
never hidden.

**What it costs you.** Browsing calls TMDB and RAWG from the server, but poster
images load in the browser straight from `image.tmdb.org` and `media.rawg.io`,
so those hosts see the viewer's IP. Titles already in Radarr/Sonarr are worked
out by reading each library once a minute at most; if an \*arr is down the grid
still loads, just without the *In library* badges.

## Choosing a specific release

**Choose release** (Search > a result > *Options*, admin only) is the way to pick
the exact release yourself instead of letting the \*arr's automatic search
decide. It replaced the old Get page, and it exists because of a sharp,
unforgiving rule in every \*arr:

> An \*arr will not import a download for something that is not in its library.

Put a torrent in the `radarr` category for a film Radarr has never heard of and
it is filed as *Unknown* in Activity. Nothing renames it. Nothing moves it. It
sits in the download directory forever, and no error is raised anywhere — which
is exactly the failure this flow removes.

So Choose release runs the steps in the only order that works:

```
1. identify  the hub already knows the exact title and which *arr owns it
             ("dune" the film and "dune" the series are different results)
        |
2. prepare   add the chosen title to its *arr (root folder + quality profile),
             monitored, WITHOUT an automatic search  ->  library id
        |
3. search    that *arr's OWN interactive search across its indexers
             (Sonarr: one season; Lidarr: an album or the whole artist)
        |
4. grab      POST the release back to the *arr -> its queue, its download
             client, its import, its rename, its root folder
```

After step 4 TorHQ is out of the way entirely. The \*arr owns the download from
the first byte, so the import, the rename and the final placement are simply the
\*arr doing what it always does — which is why the file ends up in the right
folder instead of the download directory.

**What you get from using the \*arr's own search** rather than a raw indexer
query: every release is already parsed and scored against your quality profile.
Releases the profile would refuse are listed separately with the \*arr's own
words for why — *"Bluray-2160p is not wanted in profile"*, *"Existing file meets
cutoff"* — and can still be grabbed as a deliberate override, exactly as the
\*arr's own UI allows.

**Placement.** Each \*arr has a default root folder and quality profile, shown
in the sheet's *Options* and changeable there before you choose a release. With
nothing saved, TorHQ falls back to that \*arr's first root folder and first
quality profile and says so under the fields. Nothing about placement is silent.

**Timing.** An interactive search queries every indexer in series and routinely
takes one to three minutes — on a real stack, 111 releases took over a minute. It
therefore runs as a background job that the sheet polls, rather than a request
held open across a reverse proxy that would kill it half way. Search jobs live in
memory and expire fifteen minutes after they finish; the durable work is the
\*arr's, and the \*arr already persists it.

**Idempotent.** Preparing a title that is already in the library returns the
existing entry rather than duplicating it, so re-running a flow is safe.

---

## Identifying raw releases

**Get** works title-first, so identification is never in question there. **Raw
search** is the opposite: a free-text query returns release *names*, and a name
like `Мстители: Финал / Avengers: Endgame (2019) HDRip-iTunes` has to become
"this is Avengers: Endgame, and Radarr owns it" before it can be routed anywhere.

TorHQ does that with a three-rung ladder, cheapest and most reliable first.

### 1. The \*arrs' own parsers

`GET /api/v3/parse?title=<release name>` on each configured \*arr. Free,
deterministic, and **authoritative in a way nothing else can be**: it is the same
parser the \*arr runs when deciding whether to import something, so when it
reports a library match, a grab under that \*arr's category *will* import.

It also handles far more than it looks like it should. Both of these resolve to
`Avengers: Endgame (2019)`, movie id 244, on a stock Radarr:

```
Avengers.Endgame.2019.1080p.BluRay.x264-SPARKS
Мстители: Финал / Avengers: Endgame (2019) HDRip-iTunes
```

### 2. Parsed, but not in the library

The parse read the name but the \*arr holds nothing matching it. The parsed title
and year are then a good **lookup term**, so that goes to the \*arr's own lookup
and you get candidates to choose from.

### 3. Gemini — only for what rung 1 could not read at all

Add a Gemini API key under **Services** (encrypted at rest, like every other
credential) and names no parser can read go to the model, which returns
`{kind, title, year, season}`.

> **The model never decides.** It converts a mangled string into a *search term*.
> The \*arr's own lookup produces the candidates, and **you** confirm which one it
> is. That boundary is the whole safety argument: a hallucination costs you a bad
> suggestion, not the wrong film imported into your library and renamed to match
> someone else's title.

A Gemini-sourced row is labelled as such, carries the model's own confidence, and
its confirmation dialog makes you pick the title explicitly — a parser match with
a library hit is one click, a model's guess is not.

Gemini is **optional and last**. With no key configured, rungs 1 and 2 still work
and cover the large majority of real release names; names they cannot read stay
unidentified rather than being guessed at.

### Cost

The model is reached only for names both other rungs failed on, answers are
cached for 30 minutes per exact release name, a batch is capped at 30 names, and
identification is skipped entirely on the **Web** source. The **Identify
releases** toggle on the Raw search toolbar turns the whole thing off.

`GET /api/identify/status` reports which parsers are live and whether Gemini is
configured.

---

## Search, grab, and the import loop

This section explains the mechanism — what the sources are, how a grab is routed,
and why an import stalls. For a click-by-click tour of the pages themselves, see
[Using TorHQ](#using-torhq).

The **Search** page has three sources. They answer different questions, so the
page shows all three and lets you pick:

| Source | What it is | Grabbable |
| --- | --- | --- |
| **Prowlarr** | An aggregated search across every indexer Prowlarr manages. The robust option, and the default. | Yes |
| **Torrent site** | A directly-scraped torrent-index mirror. Configuration-driven, and fragile by nature — see below. | Yes |
| **Web** | A general web search widget, for finding out *what* to look for rather than fetching it. Can embed Google's own Programmable Search widget, which needs an engine id and nothing else. | No — it links out |

A source that can't be used right now is still listed, disabled, with the reason
next to it. A missing Prowlarr, a Cloudflare-blocked mirror and a mis-typed API
key produce three different messages, not one generic failure.

### Grabbing

Choose a **target** when you grab, and the target decides what happens:

- **Radarr / Sonarr / Lidarr** — Prowlarr hands the release to its download
  client, and TorHQ immediately asks that \*arr to poll its download client
  (`RefreshMonitoredDownloads`) so it adopts and imports the download without
  waiting. The \*arr still owns the import, rename and placement.
- **qBittorrent (`torhq-manual`)** — a raw download that TorHQ owns and no \*arr
  will touch. You organize it yourself.

Only well-formed `magnet:?xt=urn:btih:<hash>` links are accepted for site grabs;
Prowlarr grabs travel by `guid` + `indexerId`, and the proxy download URL is
re-signed and origin-checked server-side before it ever reaches qBittorrent. The
grab category is restricted to a fixed allowlist.

### Why an import fails, and how to find out

Grabbing into an \*arr's category only results in an import if the whole path
lines up: the item must be added and monitored in that \*arr, qBittorrent must be
its download client with the matching category, Completed Download Handling must
be on, and — the one that catches everyone — **the \*arr container must actually
be able to see the directory qBittorrent writes to.** A download client on a
different host, or an LXC without the right bind mount, produces a silent
never-imports loop with no error anywhere.

The **Transfers** page runs those checks (`GET /api/pipeline/check`) and
names the fix for each failing one. It also lists downloads that finished but
could not be imported, and can ask the owning \*arr to scan one again. TorHQ
never repairs a mismatch itself and never moves a file to work around one.

> **Tip:** if downloads and libraries sit on the same filesystem, bind-mount the
> download directory into each \*arr at the *same path qBittorrent uses*. Imports
> then hardlink — instant, and no second copy of the data.

### Configuring a mirror (and why it's fragile)

Public torrent-index mirrors rot constantly — domains change, markup drifts, and
many sit behind Cloudflare. So the scraper is **fully configuration-driven**: the
`torrentsearch` service's *extra* config holds the search-path template and a CSS
selector for each field (row, title, magnet, seeders, leechers, size, detail
link), plus a `magnetOnDetailPage` toggle. Blank fields fall back to built-in
KickassTorrents-style defaults. When a mirror changes, **re-point the base URL or
adjust a selector — no code change needed**.

If a mirror is behind a Cloudflare browser challenge, a plain server-side fetch
gets blocked; TorHQ surfaces a clear error rather than failing silently. Set an
optional **Cloudflare solver URL** in the same config to route fetches through a
challenge solver.

Any service speaking FlareSolverr's `/v1` API works, but the choice matters:

- **[Byparr](https://github.com/ThePhaseless/Byparr)** — use this. It drives a
  real browser and clears the challenges that currently stop everything else.
- **[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)** — the original,
  and the reason the config key is still `flaresolverrUrl`. It no longer clears
  current Cloudflare challenges: it detects them and then times out, on every
  attempt, regardless of browser version or headless setting.

Because a browser-driving solver is slow to start, the solver timeout defaults
to **120 s** (`solverTimeoutMs`, 10–300 s). TorHQ's own socket timeout sits above
the solver's deadline on purpose, so a failed solve returns the solver's own
explanation instead of an aborted connection.

### The web widget

The web source never scrapes google.com. It supports four providers:

- **`link`** (default, zero-config) — builds ready-made link-outs to the search
  engines you'd have opened in another tab anyway. Works with no credentials.
- **`widget`** — Google's own [Programmable Search
  Engine](https://programmablesearchengine.google.com/) embed, rendered on the
  page. **Needs only the engine id (`cx`)** — no API key, no daily quota. This
  is the least-setup way to get real Google results inside TorHQ.
- **`google`** — the Programmable Search **JSON API**, using the same `cx` plus
  an API key. Results are rendered by TorHQ in the app's own styling, but the
  free tier stops at 100 queries a day.
- **`searxng`** — your own SearXNG instance.

A provider that fails degrades to `link` and says so, rather than returning
nothing.

**What the widget costs you.** It is the one part of TorHQ that loads
third-party code: the browser fetches `cse.js` from Google and queries Google
directly, so the search terms and the viewer's IP go to Google without passing
through the server. That is unavoidable for an embed, and it is what removes the
API key and the quota. If you would rather nothing left your network unproxied,
use `searxng`; if you would rather TorHQ do the talking, use `google`.

TorHQ mounts the widget in its *results-only* layout, so the page keeps its own
search box and feeds the term in. The widget renders in Google's own light
styling — it will not follow TorHQ's dark theme, because restyling markup from
another origin reliably produces unreadable results rather than a matching one.

---

## Local development

Requires **Node 22** (the supported version; Node 20 still works). `better-sqlite3` is a native module, so a C
toolchain is needed on first install (`build-essential python3` on Debian).

```bash
git clone https://github.com/thelorax1775/torhq.git torhq && cd torhq
npm install            # installs both workspaces from the committed lockfile

# Minimal dev environment (loopback, an approved root you can write to):
export TORHQ_MASTER_KEY="$(openssl rand -base64 48)"
export TORHQ_DATA_DIR="$PWD/.dev/data"
export TORHQ_APPROVED_ROOTS="$PWD/.dev"
export NODE_ENV=development
mkdir -p "$PWD/.dev"

# Terminal 1 — API on :8787 (tsx watch)
npm run dev

# Terminal 2 — Vite dev server on :5173, proxying /api and /webhooks to :8787
npm run dev:web
```

Open <http://localhost:5173> and create the admin account.

### Testing the web UI

`npm test` runs the server suite (`tests/`) and the web suite (`web/src/**/*.test.tsx`,
Vitest + Testing Library on jsdom); CI runs the same command. Web tests use
`mockApi()` from `web/src/test/mockApi.ts`, which stubs `fetch` for `/api/*`
(`mockApi({ "POST /api/auth/login": { status: 401, body: { error: "nope" } } })`)
and records the calls it receives.

`scripts/ui-screenshots.mjs` is a manual smoke check, not part of CI. After
`npm run build` it starts the built app on a random port against a temp data dir
and throwaway master key, seeds an admin and a member, signs in as each in
headless Chromium, and saves a PNG of every routed page at 1280px and 390px:

```bash
CHROMIUM_PATH=/path/to/chrome node scripts/ui-screenshots.mjs ./screenshots
# files: screenshots/{admin,member}/<page>-{1280,390}.png
```

No services are configured, so pages show their empty states. It exits non-zero
if a page throws.

### Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with hot reload (`tsx watch`). |
| `npm run dev:web` | Vite dev server for the SPA. |
| `npm test` | Vitest (crypto, path safety, auth/routing, intake, migrations). |
| `npm run typecheck` | `tsc --noEmit` for both workspaces. |
| `npm run build` | Compile server (`tsc`) and build the SPA (`vite build`). |
| `npm start` | Run the compiled server (`node server/dist/index.js`). |
| `npm run migrate` | Apply database migrations standalone. |

---

## Environment variables

Only **infrastructure** config lives in the environment. Per-service API keys and
passwords are entered in the setup wizard and stored **encrypted** in the
database — never in env, never in git. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | `development` \| `test` \| `production`. |
| `TORHQ_HOST` | `127.0.0.1` | Bind address. Keep on loopback; expose via a reverse proxy. |
| `TORHQ_PORT` | `8787` | Bind port. |
| `TORHQ_DATA_DIR` | `/srv/torhq/data` | Writable dir holding `torhq.db`. |
| `TORHQ_MASTER_KEY` | *(required)* | 16+ char key used to derive the AES-256-GCM key that encrypts stored secrets. **Generate with `openssl rand -base64 48`.** Changing it after services are saved makes existing secrets unrecoverable. |
| `TORHQ_APPROVED_ROOTS` | `/srv/torhq` | Colon-separated base dirs. **Every** filesystem operation must stay inside one of these. Keep as tight as possible. |
| `TORHQ_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` (enable **only** behind a trusted reverse proxy). |
| `TORHQ_COOKIE_SECURE` | `false` | Mark the session cookie `Secure` (enable when served over HTTPS). |
| `TORHQ_METRICS_ENABLED` | `false` | Expose Prometheus metrics at `/metrics`. |
| `TORHQ_GITHUB_TOKEN` | *(unset)* | Optional, in `/etc/torhq/torhq.env` only: read-only GitHub token the update helper uses for a private repo. Never logged. |
| `TORHQ_LOG_LEVEL` | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. |

---

## First-run setup

Steps 1–3 get you a working UI. **Steps 4–6 are what make imports actually
happen** — a stack that skips them looks perfectly configured and silently never
imports anything. The pipeline checks on **Transfers** verify all of it, so if you
would rather not read ahead: do steps 1–3, open **Transfers**, and fix whatever it
lists under *Needs attention*.

1. **Create the admin account.** The first visit shows a one-time registration
   screen (`POST /api/auth/register`). Once an admin exists, registration is
   permanently disabled and the screen becomes a login form.

2. **Add your services.** On the **Services** page, enter each service's base URL
   and secret, use **Test connection**, then save. Secret formats:
   - Radarr / Sonarr / Lidarr / Prowlarr — API key
   - qBittorrent — `username:password`
   - slskd — API key (set a **webhook token** in its extra config to enable the intake webhook)
   - Jellyfin — API token
   - Navidrome — `username:password`
   - Kavita — API key (optionally set a **library ID** to trigger explicit scans)
   - tmdb — API key or read access token (Discover movies and TV; optional)
   - rawg — API key (Discover games; optional)
   - torrentsearch — no secret; set the base URL to a torrent-index mirror and,
     if needed, override the site-profile selectors / add a Cloudflare solver URL
     (Byparr — see [the torrent site source](#configuring-a-mirror-and-why-its-fragile))
   - websearch — no secret for the default link-out provider. For real Google
     results the cheapest setup is provider `widget` with just a `cx` from
     programmablesearchengine.google.com; provider `google` additionally needs an
     API key and is capped at 100 queries a day; or point `searxngUrl` at your
     own SearXNG

   Secrets are write-only: TorHQ shows *configured* / *not set* and never returns
   the value. Leaving a secret field blank when editing keeps the stored one.

3. **Define intake libraries** (only if you use manual intake). On the
   **Libraries** page, create Kavita/Navidrome destinations. Both the destination
   and staging paths must live inside an approved root and, for atomic imports,
   on the same filesystem. Pick an **import mode** per library: *Move* deletes
   the source once the import succeeds; *Hardlink* imports in place and leaves it
   alone, which is what you want when importing off a seeding torrent.

4. **Create qBittorrent categories.** One per *arr, plus one you own:
   `radarr`, `sonarr`, `lidarr`, `torhq-manual`, `torhq-games` if you will
   grab games from Discover, and `torhq-books` if you will use the
   [Books](#books-ebooks) flow (its save path must be inside an approved root). The category is how a finished download is
   attributed to the app that should import it.

5. **Wire qBittorrent into each \*arr.** In Radarr/Sonarr/Lidarr →
   *Settings → Download Clients*, add qBittorrent, **set its category to the
   matching name from step 4**, and make sure *Completed Download Handling* is
   on. In Prowlarr → *Settings → Apps*, add each \*arr so indexers sync to them,
   and add qBittorrent under *Settings → Download Clients*.

6. **Make the download directory visible to each \*arr.** This is the step
   that catches everyone. Each \*arr must be able to reach qBittorrent's save
   path **at the same path string qBittorrent reports**, or it will be handed a
   directory that does not exist in its filesystem and will never import.

   On Proxmox LXC, bind-mount it into every \*arr container:

   ```bash
   # Replace 128 with each *arr's container id, and the paths with your own.
   pct set 128 -mp3 /mnt/pve/storage/torrents,mp=/mnt/torrents
   pct reboot 128
   ```

   Keep the container path identical to qBittorrent's and you need no remote path
   mapping — and because downloads and libraries then share a filesystem, imports
   **hardlink**: instant, and no second copy of the data.

   Docker users: mount the same host directory at the same path in every
   container, not `/downloads` in one and `/data/torrents` in another.

Then open **Transfers** and confirm nothing is listed under *Needs attention*. A scripted
walkthrough of every endpoint is in [`docs/curl-examples.md`](docs/curl-examples.md).

---

## Using TorHQ

Everyone gets three pages: **Search**, **Discover** and **Activity**. On a phone
they are the tab bar along the bottom (with *More* for the full menu); on a
desktop they head the sidebar. Admins also get **Library** and **System** below
them. Every page says in one line, under its title, what it is for.

| Group | Page | What it is for |
| --- | --- | --- |
| | **Search** | Find anything and add it (admin) or ask for it (member). |
| | **Discover** | Browse what's trending or popular, then add it the same way. |
| | **Activity** | Follow everything that was asked for until it is ready. Admins: the *Requests* tab, with a count on the nav link. |
| Library | **Imports to approve** | Finished book and audiobook downloads waiting for your OK (count on the nav link), and importing a folder by hand. |
| Library | **Libraries** | The folders TorHQ files books, comics, audiobooks and music into when it imports them itself. |
| System | **Transfers** | What qBittorrent, Soulseek and the \*arr queues are doing right now. |
| System | **History** | What TorHQ did and who asked, plus its own import jobs. |
| System | **Services** | The apps TorHQ talks to, and how to reach them. |
| System | **Mounts** | The network shares TorHQ can see and the free space where it may write. |
| System | **Settings** | This browser's display preferences and what this TorHQ may touch. |
| System | **Users** | Accounts for you and your friends. |

Old bookmarks keep working: `/get` opens Search, `/requests` opens Activity
(its Requests tab for an admin), `/downloads` and `/queue` open Transfers, `/jobs`
opens History, `/intake` opens Imports to approve, `/catalogue` opens Discover.
`/dashboard`, `/books` and `/audiobooks` still render but are not in the nav.

### Search (home)

The landing page for everyone. Type once; results from every kind appear in a
grid (the query and kind chips live in the URL, so a search is a shareable
link). Click a result for the detail sheet. Its one primary button is **Add**
for an admin (adds the title to Radarr/Sonarr/Lidarr, then asks that app to run
its own automatic search) or **Request** for a member. It is disabled, with the
reason on it, when the title is already available, requested or downloading.
**Options** shows the quality profile and root folder, prefilled from your saved
defaults; admins also get **Choose release** there, which picks a specific
release without leaving the sheet: for a film the \*arr's search starts at once,
for TV you choose a season, for music an album (or the whole artist). Releases
the \*arr would refuse are hidden behind *Show refused*, each with its reason, and
can still be grabbed on purpose. See [Choosing a specific release](#choosing-a-specific-release).
A source that is down or unconfigured shows why above the results instead of
hiding. After adding, the badge flips to *Requested* and a toast links to Activity.

Under an admin's results, **Not finding it? Search indexers directly** opens the
raw indexer search with the same words. Use it when the hub can't find the thing
at all (a specific edition, a game, a file no app tracks):

- **Prowlarr** aggregates every indexer you run. Narrow it with the indexer and
  category filters when a search is too broad.
- **Torrent site** is the scraper, useful when Prowlarr is down or unconfigured.
- **Web** is a link-out widget for working out *what* you want. It returns links,
  never grabbable releases.

Each row is **identified**: a badge says what it is and which \*arr owns it, with
**Send to Radarr/Sonarr/Lidarr** beside it, which adds the title to the \*arr
first and *then* grabs, so it imports and files itself. A plain **Grab** goes
where **Send grabs to** says: an \*arr's category (that \*arr is asked to poll at
once), `torhq-manual` (nothing imports it) or `torhq-games`. See
[Identifying raw releases](#identifying-raw-releases) and
[Search, grab, and the import loop](#search-grab-and-the-import-loop).

> Grabbing into an \*arr's category only imports if that title is **added and
> monitored** in the \*arr; otherwise it is filed as *Unknown* and never
> imported. Use **Send to …** or **Choose release**, which guarantee the library
> entry exists before the grab.

### Discover

Browse instead of search: pick *Movies*, *TV shows* or *Games*, then a list
(*Trending*, *Popular*, *Top rated*, …), a genre, or type a title. A poster opens
the same detail sheet and the same single action as Search. See
[Discover](#discover-browse-movies-tv-and-games).

### Activity

Every title you added or requested, tracked from *Requested* to *Available*:
requested → searching → downloading → importing → available, with a stage
stepper, a progress bar and ETA, and who asked. When something stalls it says
why in plain words and what to do (an import the \*arr refused, a download nobody
is sharing, a search that found nothing for hours, a download folder the \*arr
cannot see). Filter by in progress, stalled or done; it refreshes itself. Members
see their own requests plus other people's in-flight items as generic progress;
the admin sees everything, and each row links to Transfers or History for the
detail.

**Requests** (admin tab, with a count on the Activity nav link) — what friends
asked for that waits for you. Movies, TV and music never wait: Radarr, Sonarr and
Lidarr start looking for those by themselves. Books and audiobooks have no app
to do that, so each request waits here: **Approve** has TorHQ search Prowlarr and
grab the best match (epub/m4b first, then seeders), **Decline** closes it, and
*Choose the release yourself* opens the Books or Audiobooks page's release picker.

### Library

**Imports to approve** — when a requested book or audiobook finishes downloading,
TorHQ builds an import preview (what will be filed, where, how big) and it waits
here, with a count on the nav link, until you **Approve import** or **Decline**.
Nothing moves before that. Below it, **Import files by hand** stages content the
\*arr do not own (books, manga, comics, music) into a library. **Preview is
mandatory**: a dry run validates both paths against the approved roots and shows
exactly what would move, and the Import button disables itself the moment the
form stops matching the preview. A library in *Move* mode warns that the source
is about to be deleted. This never touches a Radarr/Sonarr/Lidarr library.

**Libraries** — the destinations TorHQ's own imports file into (Kavita,
Audiobookshelf, Navidrome), each with its **import mode** (*Move* or *Hardlink*;
see [the intake boundary](#the-intake-boundary-torhq-vs-the-arr)). Removing one
only makes TorHQ forget it; nothing on disk is deleted, and the removal is
refused while import jobs are still queued against it.

The **Books** and **Audiobooks** pages (`/books`, `/audiobooks`, not in the nav)
hold the manual release picker for a book request; see [Books](#books-ebooks).

### System

**Transfers** — one table of what qBittorrent, Soulseek (slskd) and the
Radarr/Sonarr/Lidarr queues are doing right now: *Name*, *From*, *Status*,
*Progress*, *Size*, *Time left*. An \*arr queue item and the torrent behind it are
one row (*Radarr via qBittorrent*); each name links to its item in Activity.
Expand a row for the app's own messages. Pause or resume a torrent; **Remove** an
\*arr queue item (optionally also from qBittorrent, and optionally blocklisting the
release so it is not grabbed again; files stay on disk), or remove a plain
torrent, where deleting its files needs `DELETE` typed. Above the table,
**Needs attention** lists the pipeline checks that fail (each with the fix) and
downloads an \*arr refused to import, with *Retry import*. **Check for finished
downloads** asks every \*arr to poll its download client now. Apps that are not
set up are named in one quiet line under the table.

**History** — what TorHQ did and who asked: the append-only audit log of every
request, grab, import and change (`GET /api/activity/log`), newest first. Below
it, TorHQ's own import jobs (not the \*arr's): filter by status, expand a row for
that job's history, retry a failed or dead one.

**Services** — the apps TorHQ talks to, with a per-service *Test connection*
that reports the real reason for a failure (wrong port, 401, timeout) rather than
a generic error. Saved keys and passwords are never shown again.

**Mounts** — read-only storage visibility: which network shares are bind-mounted
in, and free space on each approved root. TorHQ runs unprivileged and cannot
mount anything itself, so the "add a share" box generates the host-side command
for you to run — nothing on this page changes storage.

**Settings** — theme (system/dark/light) and background refresh rate, both stored
in this browser only, plus the approved roots this instance is allowed to touch.
Turning the refresh rate down is worth doing for an always-on wall display.

**Users** — accounts for you and your friends. A friend (member) can search, ask
for things and follow them in Activity; every admin page and admin API answers a
member with 403. A member never sees or chooses a server path: `/api/jobs` and
`/api/queue` are admin-only, `/api/downloads` gives a member only the transfer
totals, `/api/requests/*/options` gives a member the quality profiles but an empty
root-folder list, and a member request that names `rootFolderPath` is refused.
An admin's `rootFolderPath` must be one of the *arr's own root folders.

### Dashboard

Admin only, at `/dashboard` (not in the nav). Pipeline health, current transfers
and queue depth, service health, storage and failed import jobs on one page.

---

## Production deployment (LXC)

TorHQ is designed to run as an unprivileged systemd service inside a Debian 12
Proxmox LXC, behind an optional nginx TLS terminator.

### One-line install on a Proxmox VE host (auto-creates the LXC)

Run this **on the Proxmox VE host** (as root). It creates a fresh unprivileged
Debian 12 container, installs TorHQ inside it, and starts it — no manual
container setup:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/torhq/main/scripts/proxmox-install.sh)"
```

When it finishes it prints the container IP; open `http://<container-ip>:8787` and
create the admin account.

**If the repository is private**, `raw.githubusercontent.com` can't serve the
script and the in-container `git clone` needs credentials. Use a GitHub token
(fine-grained PAT with **Contents → Read-only** on this repo) — export it so both
the download and the clone can authenticate:

```bash
export TORHQ_GIT_TOKEN=github_pat_xxxxxxxx
bash -c "$(curl -fsSL \
  -H "Authorization: Bearer $TORHQ_GIT_TOKEN" \
  -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/thelorax1775/torhq/contents/scripts/proxmox-install.sh)"
```

The exported `TORHQ_GIT_TOKEN` is inherited by the script and used for the clone;
it is passed to git via a request header, so it is never written to disk. (If you
make the repo public, the plain `curl … raw.githubusercontent.com …` one-liner
above works with no token.)

By default it shows an **interactive menu** (like the community-scripts
installers): confirm the defaults, or choose **Advanced** to pick the container
ID, resources, **storage location** (rootfs and template storage are listed from
your *enabled* Proxmox storages), network (DHCP or a static IP), and more.

For unattended runs, set the values via environment variables and
`TORHQ_NONINTERACTIVE=1` to skip the menu. Every setting has an override:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TORHQ_CTID` | next free id | LXC container ID. |
| `TORHQ_HOSTNAME` | `torhq` | Container hostname. |
| `TORHQ_DISK` | `8` | Root disk size (GB). |
| `TORHQ_RAM` | `2048` | RAM (MB). |
| `TORHQ_CORES` | `2` | vCPU count. |
| `TORHQ_STORAGE` | auto (first enabled `rootdir`; `local-lvm` if present) | Storage for the rootfs. |
| `TORHQ_TEMPLATE_STORAGE` | auto (first enabled `vztmpl`) | Storage the Debian template is downloaded to. |
| `TORHQ_NONINTERACTIVE` | *(unset)* | Set to `1` to skip the menu and use env/defaults only. |
| `TORHQ_BRIDGE` | `vmbr0` | Network bridge. |
| `TORHQ_NET` | `dhcp` | `dhcp` or a static CIDR (e.g. `192.168.1.50/24`). |
| `TORHQ_GW` | *(none)* | Gateway — **required** for a static `TORHQ_NET`. |
| `TORHQ_BIND` | `0.0.0.0` | Address TorHQ binds to inside the CT (LAN-reachable). |
| `TORHQ_BRANCH` | `main` | Git branch to install from. |

Example — a fixed IP and more resources:

```bash
TORHQ_NET=192.168.1.50/24 TORHQ_GW=192.168.1.1 TORHQ_RAM=4096 TORHQ_DISK=16 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/torhq/main/scripts/proxmox-install.sh)"
```

> The installer binds TorHQ to `0.0.0.0` so it's reachable on your LAN at the
> container IP. To expose it beyond the LAN, front it with the nginx TLS reverse
> proxy below and set `TORHQ_TRUST_PROXY`/`TORHQ_COOKIE_SECURE`.

### Mounting NFS/SMB shares (NAS storage for downloads)

To store downloads on a NAS, mount the share **on the Proxmox host** and bind it
into the container that runs qBittorrent. This is the right pattern for
unprivileged LXCs, which can't mount network filesystems themselves.

The one-line installer above **offers to set up a share during provisioning**
(interactively, or unattended when the `TORHQ_SHARE_*` variables below are set —
`TORHQ_TARGET_CTID` defaults to the new container). You can also run the host
helper any time:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/torhq/main/scripts/mount-share.sh)"
```

It prompts for the share type (NFS or SMB/CIFS), the remote path, SMB
credentials (stored root-only in `/etc/torhq-shares/<name>.cred`, never in
fstab), and an optional target container to bind into. It then:

1. Installs `nfs-common` / `cifs-utils` on the host as needed.
2. Mounts the share at `/mnt/torhq-shares/<name>` and persists it in `/etc/fstab`
   (survives reboot).
3. Adds a bind mount point to the target LXC (`pct set <ctid> -mpN …`) at the
   path you choose — then `pct reboot <ctid>` and point qBittorrent's save path
   (and its `radarr`/`sonarr` category paths) there.

Unattended example:

```bash
TORHQ_SHARE_TYPE=nfs TORHQ_SHARE_REMOTE=192.168.1.10:/volume1/media \
TORHQ_SHARE_NAME=media TORHQ_TARGET_CTID=105 TORHQ_CT_PATH=/mnt/media \
TORHQ_NONINTERACTIVE=1 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/torhq/main/scripts/mount-share.sh)"
```

> For unprivileged containers you may need to set the mount's `uid`/`gid` to your
> download user's *mapped* id (host id + 100000) via `TORHQ_SHARE_OPTS` so the
> service can write. TorHQ shows any NFS/SMB shares mounted into **its own**
> container on the dashboard (**Network mounts**), read-only — it never mounts
> anything itself.

To remove a share cleanly (host unmount + fstab entry + container bind mount +
SMB credentials), run the companion helper on the host:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/torhq/main/scripts/unmount-share.sh)"
```

### Manual install (inside an existing LXC)

```bash
# Inside the LXC, as root:
git clone https://github.com/thelorax1775/torhq.git /opt/torhq-src && cd /opt/torhq-src
./scripts/install.sh
```

`scripts/install.sh` is idempotent and will:

1. Create the unprivileged `torhq` system user.
2. Install Node.js 22 (NodeSource) if missing.
3. Create the directory layout under `/srv/torhq` (`data`, `staging`,
   `downloads`, `libraries/{movies,tv,music,books,manga}`).
4. Copy the source to `/srv/torhq/app`, run `npm ci`, and build.
5. Generate `/etc/torhq/torhq.env` with a fresh `TORHQ_MASTER_KEY` (created once,
   never overwritten), locked to `0640 torhq:torhq`.
6. Install and start the `torhq` systemd unit.

Then open `http://<lxc-ip>:8787` and create the admin account.

```bash
systemctl status torhq
journalctl -u torhq -f
```

### Reverse proxy (HTTPS)

TorHQ binds to loopback. Terminate TLS with nginx
([`deploy/torhq.nginx.conf`](deploy/torhq.nginx.conf)) and set
`TORHQ_TRUST_PROXY=true` and `TORHQ_COOKIE_SECURE=true` in the env file.

### systemd hardening

[`deploy/torhq.service`](deploy/torhq.service) runs as the `torhq` user with
`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, and a tight
`ReadWritePaths` list. **`ReadWritePaths` must include every media path you want
intake to write to** — keep it consistent with `TORHQ_APPROVED_ROOTS`.

### Updating

**From the UI (admins only):** Settings → *Updates* shows the running commit and the
newest commit on `origin/<branch>` on GitHub (this repo publishes no releases, so the
branch head is the "newest version"). *Check for updates* fetches; *Update now* is
disabled when you are up to date and asks for confirmation. The app only queues a
request; a root-owned systemd path unit (`torhq-update.path`, installed once by
`scripts/upgrade.sh`) runs the update as the `torhq` user in the background and the
page polls its status and log. The steps are: back up the database, `git pull
--ff-only`, `npm ci`, build, migrate, restart. If any step fails the checkout is reset
to the previous commit and rebuilt, the service is never restarted, so the old version
keeps running, and the pre-update backup is kept. Data and config are never touched.
The request is admin-only and CSRF-protected; no ref, path or command comes from the
request.

**Private repository:** set `TORHQ_GITHUB_TOKEN` (a read-only token) in
`/etc/torhq/torhq.env`. It is read only by the update helper, passed to git through
the environment, and never logged or shown. Without it a private repo fails with
"Cannot reach GitHub".

**Manual fallback** (also how to install the helper the first time):

```bash
/srv/torhq/app/scripts/upgrade.sh   # backs up, pulls, npm ci, build, migrate, restart
```

Migrations are forward-only and idempotent, so re-running an upgrade is safe.

---

## Backup & restore

State worth backing up is small: the SQLite database and the env file (which
holds `TORHQ_MASTER_KEY`). **Media libraries are not backed up by TorHQ.**

```bash
# Back up (WAL-safe online .backup + the env file), default dest /srv/torhq/backups
/srv/torhq/app/scripts/backup.sh
```

`scripts/backup.sh` produces `torhq-<timestamp>.tar.gz` containing a consistent
DB snapshot and a copy of `torhq.env`, and nothing else is left in the
destination. The tarball is mode `600` (owner-only) and a destination directory
the script creates is mode `700`, whatever the caller's umask, because the
archive contains the master key. Backups made before this change are probably
world-readable: run `chmod 600 /srv/torhq/backups/torhq-*.tar.gz` by hand and
delete any stray `torhq-*.db-shm` / `torhq-*.db-wal` files beside them.

> **The master key is everything.** Encrypted service secrets are unreadable
> without the `TORHQ_MASTER_KEY` that was in effect when they were saved. Protect
> the backup accordingly, and never rotate the key without re-entering secrets.

**Restore:**

```bash
systemctl stop torhq
tar -xzf torhq-<timestamp>.tar.gz -C /tmp
install -o torhq -g torhq -m600 /tmp/torhq-<timestamp>.db  /srv/torhq/data/torhq.db
install -o torhq -g torhq -m640 /tmp/torhq-<timestamp>.env /etc/torhq/torhq.env
systemctl start torhq
```

---

## Security model

- **Secrets stay server-side.** Service credentials are encrypted at rest with
  AES-256-GCM (key derived from `TORHQ_MASTER_KEY` via scrypt). The API returns
  only whether a secret is saved (shown as `••••••••`); full secrets are never sent
  to the browser or written to logs (pino redaction covers cookies, auth headers,
  and secret-ish keys).
- **Auth.** Admin and member accounts, scrypt password hashing (N=32768), server-side
  sessions in a `SameSite=Lax`, `HttpOnly` cookie with a 12-hour TTL and a constant-work
  path to blunt username-enumeration timing.
- **CSRF.** Double-submit token required on **every** state-changing request
  (including logout), via the `X-CSRF-Token` header matched against the session.
- **Rate limiting.** Global limiter plus a tighter limiter on auth and webhook routes.
- **Path containment.** Every filesystem path is validated against
  `TORHQ_APPROVED_ROOTS` with lexical traversal collapse, prefix-aliasing-safe
  prefix checks, and `realpath` symlink-escape rejection. A not-yet-created
  destination is resolved through its deepest existing parent, so a symlinked
  parent cannot lead outside the roots. Symlinks in an import source are skipped,
  never copied or recreated.
- **Webhook auth.** `/webhooks/slskd` requires a shared token compared in
  constant time.
- **Least privilege deployment.** Runs as an unprivileged user under a hardened
  systemd unit; binds to loopback by default.

---

## API

The server exposes an OpenAPI 3.1 document at `GET /api/openapi.json`, and a
`curl` walkthrough of every endpoint lives in
[`docs/curl-examples.md`](docs/curl-examples.md). All `/api/*` routes except the
auth endpoints require a session; all mutating routes additionally require the
CSRF header.

---

## Project layout

```
server/            Fastify API + worker (TypeScript, ESM)
  src/adapters/    one typed HTTP client per external service
  src/auth/        password hashing, sessions, CSRF plugin
  src/config/      env parsing + encrypted service/library store
  src/db/          Drizzle schema, connection, migrations
  src/queue/       durable intake queue + import state machine
  src/routes/      REST + webhook route handlers
  src/security/    path containment / traversal defenses
  src/lib/         pipeline health checks, activity log, shared helpers
web/               React + Vite SPA
  src/components/  design system (ui.tsx), app shell, icon set
  src/lib/         the single data layer: usePolled / useMutation / format / prefs
  src/pages/       one file per route
tests/             Vitest suites (crypto, paths, routing, intake, migrations,
                   search, downloads, queue, pipeline, catalogue, and the
                   self-update worker deploy/updater/update-worker.mjs, run
                   against a throwaway git origin)
scripts/           install / upgrade / backup
deploy/            systemd unit + nginx reverse-proxy config
docs/              API curl examples + the revamp contract
```

---

## Project status

Active. Single-maintainer homelab project, developed and deployed on a Proxmox
LXC. Recent work covers the Catalogue (TMDB/RAWG), admin and member accounts,
and self-update from GitHub. The Vitest suite covers the server, and the web UI has a
test harness with a first set of tests (more arrive with each page rebuild). Integrations are only as verified as the services they were
tested against, so treat any adapter you have not run yourself as unverified.

---

## License

`package.json` declares MIT, but no `LICENSE` file is committed yet.
