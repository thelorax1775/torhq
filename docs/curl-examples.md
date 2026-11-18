# TorHQ API — curl examples

Base URL assumes local access: `http://127.0.0.1:8787`.
TorHQ uses a session cookie + a CSRF token (returned by login/register and
required in the `X-CSRF-Token` header on all mutating requests).

## 0. Save the cookie jar and grab the CSRF token

```bash
BASE=http://127.0.0.1:8787
JAR=/tmp/torhq.cookies

# First run only: create the admin account.
curl -s -c $JAR -X POST $BASE/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"supersecret1"}'

# Subsequent logins:
CSRF=$(curl -s -c $JAR -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"supersecret1"}' | jq -r .csrfToken)
echo "CSRF=$CSRF"
```

## 1. Health / readiness (public)

```bash
curl -s $BASE/health
curl -s $BASE/ready
```

## 2. Configure a service (secret stored encrypted)

```bash
curl -s -b $JAR -X POST $BASE/api/services \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"kind":"radarr","label":"Radarr","baseUrl":"http://127.0.0.1:7878","secret":"RADARR_API_KEY"}'

# Test a connection (uses submitted or stored secret):
curl -s -b $JAR -X POST $BASE/api/services/test \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"kind":"radarr","label":"Radarr","baseUrl":"http://127.0.0.1:7878"}'

# List services (secrets are masked, never returned in full):
curl -s -b $JAR $BASE/api/services | jq
```

## 3. qBittorrent categories (ownership)

Configure qBittorrent with `secret` as `username:password`, then create the
ownership categories in qBittorrent itself:
`radarr`, `sonarr`, `lidarr`, `torhq-kavita`, `torhq-music`.

## 4. Submit requests (search → select → confirm; TorHQ only requests)

TorHQ never adds "the first result". You **search**, pick a specific candidate by
its `selectionId`, then **confirm**. Routes: `movie` (Radarr), `tv` (Sonarr),
`music` (Lidarr — note Lidarr requires a `metadataProfileId`).

```bash
# 1. Load the form options (quality profiles, root folders; Lidarr also
#    returns metadataProfiles).
curl -s -b $JAR $BASE/api/requests/movie/options | jq

# 2. Search and pick a candidate.
curl -s -b $JAR "$BASE/api/requests/movie/search?term=Blade%20Runner%202049" | jq
#    -> { "candidates": [ { "selectionId": "tmdb:335984", "title": "...", ... } ] }

# 3. Confirm the chosen selectionId.
curl -s -b $JAR -X POST $BASE/api/requests/movie \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"term":"Blade Runner 2049","selectionId":"tmdb:335984","qualityProfileId":1,"rootFolderPath":"/data/movies","searchNow":true}'

# TV -> Sonarr (selectionId is "tvdb:<id>")
curl -s -b $JAR "$BASE/api/requests/tv/search?term=Severance" | jq
curl -s -b $JAR -X POST $BASE/api/requests/tv \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"term":"Severance","selectionId":"tvdb:371980","qualityProfileId":1,"rootFolderPath":"/data/tv","searchNow":true}'

# Artist -> Lidarr (selectionId is "mbid:<musicbrainz-id>"; metadataProfileId required)
curl -s -b $JAR "$BASE/api/requests/music/search?term=Radiohead" | jq
curl -s -b $JAR -X POST $BASE/api/requests/music \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"term":"Radiohead","selectionId":"mbid:a74b1b7f-71a5-4011-9441-d0b5e4122711","qualityProfileId":1,"metadataProfileId":1,"rootFolderPath":"/data/music","searchNow":true}'
```

## 4b. Search → grab

Three sources sit behind `/api/search`: `prowlarr` (the default, aggregated
across every indexer Prowlarr manages), `site` (a scraped torrent-index mirror),
and `web` (a general web widget that returns links, not grabbable releases).
`/api/search*` reads are auth-only; `/api/search/grab` mutates and needs the CSRF
header.

```bash
# What can be searched right now, and why not when it can't. An unavailable
# source is still listed, with the reason in `detail`:
curl -s -b $JAR "$BASE/api/search/sources" | jq
#   -> { "sources": [ { "id": "prowlarr", "label": "Prowlarr", "available": true, "detail": "9 indexers" }, ... ] }

# Prowlarr's indexers, for the category/indexer filters:
curl -s -b $JAR "$BASE/api/search/indexers" | jq '.indexers[] | {id, name, enable}'

# Search every indexer Prowlarr manages (strongest-seeded first). `seeders: null`
# means the indexer reported no count — it does not mean zero:
curl -s -b $JAR "$BASE/api/search?source=prowlarr&q=Blade%20Runner%202049%202160p" | jq
#   -> { "source": "prowlarr", "results": [ { "guid": "...", "indexerId": 2, "title": "...", "seeders": 900, ... } ] }

# Narrow it to specific indexers and categories (comma-separated):
curl -s -b $JAR "$BASE/api/search?source=prowlarr&q=blade+runner&indexerIds=2,7&categories=2000&limit=50" | jq

# The configured torrent site instead (returns magnets):
curl -s -b $JAR "$BASE/api/search?source=site&q=blade+runner" | jq

# The web widget. With no provider configured it returns ready-made link-outs and
# still works; a configured provider that fails degrades to those and says so:
curl -s -b $JAR "$BASE/api/search?source=web&q=what+order+to+watch+blade+runner" | jq
```

Grabbing routes the release to whoever should import it. A Prowlarr release is
identified by `guid` + `indexerId`; a site result by its magnet.

```bash
# Hand a Prowlarr release to Radarr: Prowlarr passes it to its download client,
# then Radarr is nudged to adopt and import it. Radarr owns the import.
curl -s -b $JAR -X POST $BASE/api/search/grab \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"source":"prowlarr","guid":"https://indexer.example/download.php?id=1","indexerId":2,"target":"radarr","title":"Blade Runner 2049"}'

# Or keep it: `manual` lands in the torhq-manual category, which no *arr touches.
curl -s -b $JAR -X POST $BASE/api/search/grab \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"source":"prowlarr","guid":"https://indexer.example/download.php?id=1","indexerId":2,"target":"manual"}'

# A site result is a magnet. Only well-formed magnet:?xt=urn:btih:<hash> is accepted:
curl -s -b $JAR -X POST $BASE/api/search/grab \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"source":"site","magnet":"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567","target":"sonarr"}'
```

## 4c. Downloads, queue, and why an import stalled

```bash
# Everything in qBittorrent, with global rates and the category map:
curl -s -b $JAR "$BASE/api/downloads" | jq '.torrents[] | {name, category, state, progress}'

# Act on torrents. deleteWithFiles is the only action that destroys data on disk:
curl -s -b $JAR -X POST $BASE/api/downloads/action \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"hashes":["0123456789abcdef0123456789abcdef01234567"],"action":"pause"}'

# The Radarr/Sonarr/Lidarr queues merged. A service that is down is listed under
# `unavailable` and never fails the response:
curl -s -b $JAR "$BASE/api/queue" | jq '{items: [.items[] | {service, title, trackedDownloadState}], unavailable}'

# Ask every *arr to poll its download client right now:
curl -s -b $JAR -X POST $BASE/api/queue/refresh -H "x-csrf-token: $CSRF" | jq

# Drop one item. Files stay on disk either way:
curl -s -b $JAR -X POST $BASE/api/queue/radarr/12/remove \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"removeFromClient":true,"blocklist":true}'
```

The pipeline checks answer "why did this download never become a library file?"
They are read-only: each failing check names the fix, and TorHQ never applies it.

```bash
# Only the problems, with what to do about each:
curl -s -b $JAR "$BASE/api/pipeline/check" | jq '.checks[] | select(.ok | not) | {severity, label, detail, fix}'
#   The one that catches everyone:
#   "Radarr can see qBittorrent's download directory" -> error, "Radarr cannot see
#   /mnt/torrents/radarr" — the directory was never mounted into Radarr's
#   container, so downloads complete and then sit there with no error anywhere.

# Downloads that finished but could not be imported:
curl -s -b $JAR "$BASE/api/pipeline/failed-imports" | jq '.items[] | {service, title, reason}'

# Ask the owning *arr to scan one again. It does the scanning, moving and
# renaming; TorHQ only points it at its own output path:
curl -s -b $JAR -X POST $BASE/api/pipeline/manual-import \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"service":"radarr","downloadId":"0123456789abcdef0123456789abcdef01234567"}'
```

## 5. Manual intake (books/manga -> Kavita, music -> Navidrome)

```bash
# Define a destination library:
curl -s -b $JAR -X POST $BASE/api/libraries \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"key":"kavita-manga","label":"Kavita Manga","kind":"manga","targetService":"kavita","destPath":"/srv/torhq/libraries/manga","stagingPath":"/srv/torhq/staging/manga"}'

# Preview (dry run — validates paths, shows what will move):
curl -s -b $JAR -X POST $BASE/api/intake/preview \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"libraryKey":"kavita-manga","sourcePath":"/srv/torhq/downloads/torhq-kavita/SomeSeries"}'

# Enqueue the intake job (durable, idempotent):
curl -s -b $JAR -X POST $BASE/api/intake \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"libraryKey":"kavita-manga","sourcePath":"/srv/torhq/downloads/torhq-kavita/SomeSeries"}'
```

## 6. Jobs, activity, and retries

```bash
curl -s -b $JAR $BASE/api/jobs | jq
curl -s -b $JAR $BASE/api/jobs/<jobId> | jq
curl -s -b $JAR -X POST $BASE/api/jobs/<jobId>/retry -H "x-csrf-token: $CSRF"
curl -s -b $JAR $BASE/api/activity | jq            # the Activity list
curl -s -b $JAR $BASE/api/activity/log?limit=50 | jq   # raw audit log (admin)
```

## 7. Dashboard data

```bash
curl -s -b $JAR $BASE/api/status/health | jq
curl -s -b $JAR $BASE/api/status/downloads | jq
curl -s -b $JAR $BASE/api/status/arr-activity | jq
curl -s -b $JAR $BASE/api/status/slskd | jq
curl -s -b $JAR $BASE/api/status/storage | jq
curl -s -b $JAR $BASE/api/status/failures | jq
```

## 8. slskd completed-download webhook (token auth)

Set a `webhookToken` in the slskd service's `extra` config, then:

```bash
curl -s -X POST $BASE/webhooks/slskd \
  -H "x-torhq-token: THE_WEBHOOK_TOKEN" -H 'content-type: application/json' \
  -d '{"localPath":"/srv/torhq/downloads/torhq-music/Artist - Album","filename":"Artist - Album"}'
```

## 9. OpenAPI spec

```bash
curl -s $BASE/api/openapi.json | jq
```
