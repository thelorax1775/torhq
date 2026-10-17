import type { FastifyInstance } from "fastify";

/**
 * Hand-authored OpenAPI 3.1 document. It describes the auth/CSRF model, request
 * and response shapes, and error envelopes for the endpoints the SPA and the
 * documented curl flows use. Auth: a session cookie (`torhq_sid`); every
 * mutating request additionally requires the `X-CSRF-Token` header.
 */
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const jsonBody = (ref: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const jsonOk = (ref: string, description = "OK") => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const csrfHeader = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  description: "Per-session CSRF token returned by login/register.",
  schema: { type: "string" },
};

export const openApiDoc = {
  openapi: "3.1.0",
  info: {
    title: "TorHQ API",
    version: "1.0.0",
    description:
      "Control plane for a Proxmox media homelab. All /api routes except the auth " +
      "endpoints require a session cookie; all mutating routes also require the " +
      "X-CSRF-Token header. TorHQ never returns decrypted service secrets.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "torhq_sid" },
      csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          issues: { type: "array", items: { type: "object" }, description: "Zod issues on validation failure." },
        },
      },
      Ok: { type: "object", properties: { ok: { type: "boolean" } } },
      ArrService: { type: "string", enum: ["radarr", "sonarr", "lidarr"] },
      IdentifyInput: {
        type: "object",
        required: ["release"],
        properties: { release: { type: "string", maxLength: 512, description: "The raw torrent release name." } },
      },
      IdentifyBatchInput: {
        type: "object",
        required: ["releases"],
        properties: {
          releases: { type: "array", minItems: 1, maxItems: 30, items: { type: "string", maxLength: 512 } },
        },
      },
      Identification: {
        type: "object",
        description: "What a raw release name was identified as, and by whom.",
        properties: {
          release: { type: "string", description: "Echoed, so a batch answer can be matched to its request." },
          source: {
            type: "string", enum: ["arr-parse", "gemini", "none"],
            description: "Which rung answered. 'arr-parse' is authoritative; 'gemini' is a model's proposal.",
          },
          service: { oneOf: [{ $ref: "#/components/schemas/ArrService" }, { type: "null" }] },
          title: { type: "string" },
          year: { type: "integer" },
          seasonNumber: { type: "integer", description: "Sonarr only." },
          libraryId: {
            type: ["integer", "null"],
            description:
              "Set when the *arr already holds this in its library - the strong case, where a grab under " +
              "that *arr's category will import with no add step.",
          },
          libraryTitle: { type: "string" },
          candidates: {
            type: "array",
            description: "Lookup candidates when it is NOT already in the library. The user picks one.",
            items: { $ref: "#/components/schemas/AcquireCandidate" },
          },
          confidence: { type: "number", description: "1 for a library match; the model's own estimate for a Gemini answer." },
          detail: { type: "string", description: "Human-readable explanation, naming whose answer this is." },
        },
      },
      AcquireCandidate: {
        type: "object",
        description: "A lookup match, carrying the *arr it belongs to so one list can span all three.",
        properties: {
          service: { $ref: "#/components/schemas/ArrService" },
          selectionId: { type: "string", description: "Stable selector (tmdb:/tvdb:/mbid:) - never a list index." },
          title: { type: "string" }, subtitle: { type: "string" },
          year: { type: "integer" }, poster: { type: "string" }, overview: { type: "string" },
          alreadyAdded: { type: "boolean", description: "Already in that *arr's library; preparing it will not duplicate." },
        },
      },
      AcquirePrepareInput: {
        type: "object",
        required: ["service", "term", "selectionId"],
        properties: {
          service: { $ref: "#/components/schemas/ArrService" },
          term: { type: "string", description: "The term the candidate came from; the lookup is re-run and matched on selectionId." },
          selectionId: { type: "string" },
          rootFolderPath: { type: "string", description: "Overrides the saved default for this grab only." },
          qualityProfileId: { type: "integer" },
          metadataProfileId: { type: "integer", description: "Lidarr only; required there." },
          remember: { type: "boolean", description: "Persist these choices as this *arr's defaults." },
        },
      },
      AcquireSearchInput: {
        type: "object",
        required: ["service", "id"],
        properties: {
          service: { $ref: "#/components/schemas/ArrService" },
          id: { type: "integer", description: "The *arr library id returned by /prepare (movie/series/artist)." },
          label: { type: "string" },
          seasonNumber: { type: "integer", description: "Sonarr only, and REQUIRED there - it refuses a whole-series search." },
          albumId: { type: "integer", description: "Lidarr only; narrows an artist-wide search to one album." },
        },
      },
      AcquireGrabInput: {
        type: "object",
        required: ["service", "guid", "indexerId"],
        properties: {
          service: { $ref: "#/components/schemas/ArrService" },
          guid: { type: "string", description: "The *arr's own handle for the release, from the search result." },
          indexerId: { type: "integer" },
          title: { type: "string" },
          override: { type: "boolean", description: "The release was rejected by the quality profile and is being grabbed deliberately." },
        },
      },
      AcquireDefaultsInput: {
        type: "object",
        required: ["service"],
        properties: {
          service: { $ref: "#/components/schemas/ArrService" },
          rootFolderPath: { type: "string" },
          qualityProfileId: { type: "integer" },
          metadataProfileId: { type: "integer" },
        },
      },
      ArrRelease: {
        type: "object",
        description: "One result of an *arr's interactive search - already parsed and scored against its quality profile.",
        properties: {
          guid: { type: "string" }, indexerId: { type: "integer" }, indexer: { type: "string" },
          title: { type: "string" }, size: { type: "integer" },
          seeders: { type: ["integer", "null"], description: "null when the indexer does not report it - never coerced to 0." },
          leechers: { type: ["integer", "null"] },
          protocol: { type: "string" }, quality: { type: "string" }, ageHours: { type: "number" },
          rejected: { type: "boolean", description: "The *arr's profile would have refused this release." },
          rejections: { type: "array", items: { type: "string" }, description: "Why, verbatim from the *arr." },
          infoUrl: { type: "string" },
        },
      },
      AcquireSearchJob: {
        type: "object",
        description: "A release search in progress. Poll GET /api/acquire/search/{id} until status leaves 'running'.",
        properties: {
          id: { type: "string", format: "uuid" },
          service: { $ref: "#/components/schemas/ArrService" },
          label: { type: "string" },
          status: { type: "string", enum: ["running", "done", "error"] },
          elapsedMs: { type: "integer" },
          releases: { type: ["array", "null"], items: { $ref: "#/components/schemas/ArrRelease" } },
          error: { type: ["string", "null"] },
        },
      },
      Credentials: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", minLength: 1, maxLength: 64 },
          password: { type: "string", minLength: 8, maxLength: 256 },
        },
      },
      Session: {
        type: "object",
        properties: { username: { type: "string" }, csrfToken: { type: "string" } },
      },
      Me: {
        type: "object",
        properties: {
          authenticated: { type: "boolean" },
          needsSetup: { type: "boolean" },
          csrfToken: { type: ["string", "null"] },
        },
      },
      ServiceInput: {
        type: "object",
        required: ["kind", "label", "baseUrl"],
        properties: {
          kind: {
            type: "string",
            enum: ["qbittorrent", "radarr", "sonarr", "lidarr", "prowlarr", "slskd", "jellyfin", "navidrome", "kavita", "torrentsearch"],
          },
          label: { type: "string", minLength: 1, maxLength: 64 },
          baseUrl: { type: "string", format: "uri" },
          secret: { type: "string", maxLength: 1024, description: "API key or 'user:pass'. Omit to keep the stored secret." },
          enabled: { type: "boolean" },
          extra: {
            type: "object",
            description:
              "Typed per-kind config. kavita: { libraryId }. slskd: { webhookToken } (write-only). " +
              "torrentsearch: { searchPath, rowSelector, titleSelector, magnetSelector, seedersSelector, " +
              "leechersSelector, sizeSelector, detailLinkSelector, magnetOnDetailPage, flaresolverrUrl, " +
              "solverTimeoutMs }. `flaresolverrUrl` names the FlareSolverr /v1 protocol, not the " +
              "implementation — point it at Byparr or any other drop-in that speaks it.",
          },
        },
      },
      ServiceSafe: {
        type: "object",
        description: "Browser-safe service view — secrets are masked and write-only extra fields become <key>Set booleans.",
        properties: {
          kind: { type: "string" },
          label: { type: "string" },
          baseUrl: { type: "string" },
          enabled: { type: "boolean" },
          lastHealthy: { type: ["integer", "null"] },
          lastStatus: { type: ["string", "null"] },
          secretMask: { type: ["string", "null"] },
          extra: { type: "object" },
        },
      },
      HealthResult: {
        type: "object",
        properties: {
          healthy: { type: "boolean" },
          version: { type: "string" },
          detail: { type: "string" },
          latencyMs: { type: "integer" },
        },
      },
      LibraryInput: {
        type: "object",
        required: ["key", "label", "kind", "targetService", "destPath", "stagingPath"],
        properties: {
          key: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 64 },
          label: { type: "string", minLength: 1, maxLength: 64 },
          kind: { type: "string", enum: ["books", "manga", "comics", "music"] },
          targetService: { type: "string", enum: ["kavita", "navidrome"] },
          destPath: { type: "string", description: "Must resolve inside an approved root." },
          stagingPath: { type: "string", description: "Must be inside an approved root, on the same filesystem as destPath." },
          rescan: { type: "boolean" },
          importMode: {
            type: "string",
            enum: ["move", "link"],
            default: "move",
            description:
              "How intake gets bytes from source to destination. 'move' copies into staging, reveals atomically, " +
              "then deletes the source. 'link' hardlinks instead: instant, no extra disk space, and the source is " +
              "left in place — the only safe choice when importing from a torrent that is still seeding. 'link' " +
              "requires the source and destination to be on one filesystem and fails with a clear error otherwise.",
          },
        },
      },
      Candidate: {
        type: "object",
        description: "A search result the user chooses before anything is added.",
        properties: {
          selectionId: { type: "string", description: "Stable flavor-specific id: tmdb:/tvdb:/mbid:." },
          title: { type: "string" },
          subtitle: { type: "string" },
          year: { type: "integer" },
          poster: { type: "string" },
          overview: { type: "string" },
          alreadyAdded: { type: "boolean" },
        },
      },
      AddRequest: {
        type: "object",
        required: ["term", "selectionId", "qualityProfileId", "rootFolderPath"],
        properties: {
          term: { type: "string", maxLength: 256 },
          selectionId: { type: "string", description: "The chosen candidate's selectionId — never 'the first result'." },
          qualityProfileId: { type: "integer", minimum: 1 },
          rootFolderPath: { type: "string" },
          monitored: { type: "boolean" },
          searchNow: { type: "boolean" },
          metadataProfileId: { type: "integer", minimum: 1, description: "Required for music (Lidarr)." },
        },
      },
      IntakeInput: {
        type: "object",
        required: ["libraryKey", "sourcePath"],
        properties: {
          libraryKey: { type: "string" },
          sourcePath: { type: "string", description: "Absolute path inside an approved root." },
          targetName: { type: "string", maxLength: 255 },
          idempotencyKey: { type: "string", maxLength: 128 },
        },
      },
      IntakePreview: {
        type: "object",
        properties: {
          libraryKey: { type: "string" },
          sourcePath: { type: "string" },
          destPath: { type: "string" },
          importMode: { type: "string", enum: ["move", "link"] },
          totalBytes: { type: "integer" },
          warnings: { type: "array", items: { type: "string" } },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, size: { type: "integer" }, isDir: { type: "boolean" } },
            },
          },
        },
      },
      Job: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "completed", "failed", "dead"] },
          libraryKey: { type: ["string", "null"] },
          sourcePath: { type: "string" },
          attempts: { type: "integer" },
          maxAttempts: { type: "integer" },
          nextRunAt: { type: "integer" },
          lastError: { type: ["string", "null"] },
          createdAt: { type: "integer" },
          updatedAt: { type: "integer" },
        },
      },
      TorrentResult: {
        type: "object",
        description: "A normalized magnet result scraped from the configured torrent site.",
        properties: {
          title: { type: "string" },
          magnet: { type: "string", description: "magnet: URI." },
          seeders: { type: ["integer", "null"] },
          leechers: { type: ["integer", "null"] },
          sizeBytes: { type: ["integer", "null"] },
          detailUrl: { type: ["string", "null"], description: "Same-origin detail page link, if any." },
        },
      },
      ProwlarrRelease: {
        type: "object",
        description: "A normalized release from Prowlarr's aggregated search, seeders-desc.",
        properties: {
          guid: { type: "string", description: "Identifies the release to Prowlarr; required to grab it." },
          indexerId: { type: "integer" },
          indexer: { type: "string" },
          title: { type: "string" },
          size: { type: ["integer", "null"] },
          seeders: { type: ["integer", "null"], description: "null means the indexer did not report a count — not zero." },
          leechers: { type: ["integer", "null"] },
          protocol: { type: "string", enum: ["torrent", "usenet"] },
          publishDate: { type: ["string", "null"], format: "date-time" },
          infoUrl: { type: "string", description: "The indexer's own detail page." },
          downloadUrl: { type: "string", description: "Prowlarr proxy link with the API key stripped; re-signed server-side before use." },
          magnetUrl: { type: "string" },
          categories: { type: "array", items: { type: "object" } },
        },
      },
      WebSearchResult: {
        type: "object",
        description: "A general web result. Not grabbable — the web source links out, it never yields releases.",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
      },
      GrabInput: {
        type: "object",
        description:
          "A grab from either source. `site` grabs carry a magnet; `prowlarr` grabs carry guid + indexerId " +
          "and let Prowlarr hand the release to its own download client.",
        properties: {
          source: { type: "string", enum: ["prowlarr", "site"], default: "site" },
          magnet: { type: "string", description: "Required for site grabs. A well-formed magnet:?xt=urn:btih:<hash> link; non-magnet URLs are rejected." },
          guid: { type: "string", maxLength: 2048, description: "Required for prowlarr grabs." },
          indexerId: { type: "integer", minimum: 0, description: "Required for prowlarr grabs." },
          downloadUrl: { type: "string", format: "uri", description: "The key-stripped proxy link from the search result; re-signed and origin-checked server-side." },
          title: { type: "string", maxLength: 512 },
          target: {
            type: "string",
            enum: ["radarr", "sonarr", "lidarr", "qbittorrent", "games"],
            description:
              "Which *arr should adopt and import the download. `qbittorrent` (category `torhq-manual`) and " +
              "`games` (category `torhq-games`) are raw downloads TorHQ owns; no *arr will import them.",
          },
          category: {
            type: "string",
            enum: ["torhq-manual", "torhq-games", "radarr", "sonarr", "lidarr"],
            description: "Legacy alias for `target`, expressed as the qBittorrent category.",
          },
          drive: {
            type: "string",
            description:
              "Drive id for a `qbittorrent` or `games` grab: it saves to that drive's download folder, under a " +
              "folder named for the category. Omitted, the `downloads` default from /api/drives applies. " +
              "Ignored for an *arr target.",
          },
        },
      },
      DriveSettings: {
        type: "object",
        required: ["drives"],
        description:
          "The disks content can be placed on. A path belongs to the drive with the longest matching prefix, " +
          "compared on whole segments, so list every name each service uses for the same disk.",
        properties: {
          drives: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "label", "paths"],
              properties: {
                id: { type: "string", pattern: "^[a-z0-9-]+$" },
                label: { type: "string" },
                paths: { type: "array", items: { type: "string" }, description: "Absolute path prefixes, in any service's view." },
                downloadPath: { type: "string", description: "qBittorrent's folder on this drive, in qBittorrent's view." },
              },
            },
          },
          defaults: {
            type: "object",
            description: "Drive ids. `default` covers any purpose without its own entry.",
            properties: Object.fromEntries(
              ["default", "movies", "tv", "music", "books", "comics", "downloads"].map((k) => [k, { type: "string" }]),
            ),
          },
        },
      },
      DownloadAction: {
        type: "object",
        required: ["hashes", "action"],
        properties: {
          hashes: { type: "array", items: { type: "string" }, minItems: 1, description: "Torrent info hashes." },
          action: {
            type: "string",
            enum: ["pause", "resume", "recheck", "delete", "deleteWithFiles", "topPriority", "bottomPriority", "setCategory"],
          },
          category: { type: "string", description: "Required for setCategory." },
        },
      },
      QueueRemoveInput: {
        type: "object",
        properties: {
          removeFromClient: { type: "boolean", description: "Also remove the torrent from qBittorrent. Files are kept on disk." },
          blocklist: { type: "boolean", description: "Blocklist the release so the *arr does not grab it again." },
        },
      },
      ManualImportInput: {
        type: "object",
        required: ["service", "downloadId"],
        properties: {
          service: { type: "string", enum: ["radarr", "sonarr", "lidarr"] },
          downloadId: { type: "string", description: "The download client's id for the grab — a torrent hash for qBittorrent." },
        },
      },
      PipelineCheck: {
        type: "object",
        description: "One verifiable claim about the grab → download → import path.",
        required: ["id", "label", "ok", "severity", "detail"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          ok: { type: "boolean" },
          severity: { type: "string", enum: ["error", "warn", "info"] },
          detail: { type: "string" },
          fix: { type: "string", description: "What to change. Present whenever ok is false. TorHQ never applies it silently." },
        },
      },
      SlskdWebhook: {
        type: "object",
        required: ["localPath"],
        properties: {
          localPath: { type: "string", description: "Completed-download path inside an approved root." },
          username: { type: "string" },
          filename: { type: "string" },
          libraryKey: { type: "string", description: "Defaults to navidrome-music." },
        },
      },
    },
  },
  // Everything under /api (except auth) needs the cookie; mutations also CSRF.
  security: [{ cookieAuth: [] }],
  paths: {
    "/health": { get: { summary: "Liveness", security: [], responses: { "200": { description: "ok" } } } },
    "/ready": {
      get: {
        summary: "Readiness (DB check)", security: [],
        responses: { "200": { description: "ready" }, "503": errorResponse("not ready") },
      },
    },
    "/api/auth/register": {
      post: {
        summary: "First-run admin creation", security: [],
        requestBody: jsonBody("Credentials"),
        responses: { "200": jsonOk("Session"), "409": errorResponse("admin already exists"), "400": errorResponse("validation failed") },
      },
    },
    "/api/auth/login": {
      post: {
        summary: "Login (sets session cookie)", security: [],
        requestBody: jsonBody("Credentials"),
        responses: { "200": jsonOk("Session"), "401": errorResponse("invalid credentials") },
      },
    },
    "/api/auth/logout": {
      post: {
        summary: "Logout (requires CSRF)",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        responses: { "200": jsonOk("Ok"), "401": errorResponse("auth required"), "403": errorResponse("invalid CSRF token") },
      },
    },
    "/api/auth/me": {
      get: { summary: "Session probe + needsSetup flag", security: [], responses: { "200": jsonOk("Me") } },
    },
    "/api/services": {
      get: {
        summary: "List services (secrets masked)",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            services: { type: "array", items: { $ref: "#/components/schemas/ServiceSafe" } },
            kinds: { type: "array", items: { type: "string" } },
          } } } } },
          "401": errorResponse("auth required"),
        },
      },
      post: {
        summary: "Create/update a service",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("ServiceInput"),
        responses: { "200": jsonOk("Ok"), "400": errorResponse("validation failed"), "403": errorResponse("invalid CSRF token") },
      },
    },
    "/api/services/test": {
      post: {
        summary: "Test a service connection (uses submitted or stored secret)",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("ServiceInput"),
        responses: { "200": jsonOk("HealthResult"), "502": jsonOk("HealthResult", "unhealthy") },
      },
    },
    "/api/libraries": {
      get: { summary: "List intake libraries", responses: { "200": { description: "OK" } } },
      post: {
        summary: "Create/update an intake library",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("LibraryInput"),
        responses: { "200": jsonOk("Ok"), "400": errorResponse("path escapes approved roots / validation") },
      },
    },
    "/api/libraries/{key}": {
      delete: {
        summary: "Forget a destination library",
        description:
          "Removes the definition only — nothing on disk is touched. Refused while intake jobs are " +
          "still queued or running against it, so the failure surfaces here rather than at import time.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader, { name: "key", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
        responses: {
          "200": jsonOk("Ok", "Removed"),
          "404": errorResponse("no library with that key"),
          "409": errorResponse("intake jobs are still queued against it"),
        },
      },
    },
    "/api/config/roots": { get: { summary: "Approved roots (read-only)", responses: { "200": { description: "OK" } } } },
    "/api/requests/{route}/options": {
      get: {
        summary: "Quality profiles, root folders (+ Lidarr metadata profiles)",
        parameters: [{ name: "route", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv", "music"] } }],
        responses: { "200": { description: "OK" }, "409": errorResponse("service not configured"), "502": errorResponse("upstream error") },
      },
    },
    "/api/requests/{route}/search": {
      get: {
        summary: "Search candidates for the user to choose from",
        parameters: [
          { name: "route", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv", "music"] } },
          { name: "term", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            candidates: { type: "array", items: { $ref: "#/components/schemas/Candidate" } },
          } } } } },
          "409": errorResponse("service not configured"),
        },
      },
    },
    "/api/requests/{route}": {
      post: {
        summary: "Add the chosen candidate (never the first result)",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          csrfHeader,
          { name: "route", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv", "music"] } },
        ],
        requestBody: jsonBody("AddRequest"),
        responses: {
          "200": { description: "Requested", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, id: { type: "integer" }, title: { type: "string" },
          } } } } },
          "400": errorResponse("validation / missing metadataProfileId for music"),
          "409": errorResponse("service not configured"),
          "502": errorResponse("upstream error / selection unavailable"),
        },
      },
    },
    "/api/search/sources": {
      get: {
        summary: "Which search sources can be used right now, and why not when they can't",
        description:
          "An unavailable source is still listed, with `detail` as the reason, so the UI can " +
          "disable it and say why rather than silently hiding a capability.",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            sources: { type: "array", items: { type: "object", properties: {
              id: { type: "string", enum: ["prowlarr", "site", "web"] },
              label: { type: "string" },
              available: { type: "boolean" },
              detail: { type: "string" },
            } } },
          } } } } },
        },
      },
    },
    "/api/search/indexers": {
      get: {
        summary: "Prowlarr's indexers and their categories, for the search filters",
        responses: {
          "200": { description: "OK" },
          "409": errorResponse("prowlarr not configured"),
          "502": errorResponse("prowlarr unreachable"),
        },
      },
    },
    "/api/search": {
      get: {
        summary: "Search one source (read-only)",
        description:
          "`prowlarr` aggregates every selected indexer; `site` scrapes the configured torrent " +
          "site; `web` is a general web widget that returns links, not grabbable releases. " +
          "The response shape depends on the source.",
        parameters: [
          { name: "source", in: "query", schema: { type: "string", enum: ["prowlarr", "site", "web"], default: "prowlarr" } },
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } },
          { name: "page", in: "query", description: "site only.", schema: { type: "integer", minimum: 1, maximum: 20 } },
          { name: "indexerIds", in: "query", description: "prowlarr only; comma-separated. Omit to search every indexer.", schema: { type: "string" } },
          { name: "categories", in: "query", description: "prowlarr only; comma-separated newznab category ids.", schema: { type: "string" } },
          { name: "limit", in: "query", description: "prowlarr only.", schema: { type: "integer", minimum: 10, maximum: 500 } },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { oneOf: [
            { type: "object", properties: {
              source: { type: "string", enum: ["prowlarr"] },
              results: { type: "array", items: { $ref: "#/components/schemas/ProwlarrRelease" } },
            } },
            { type: "object", properties: {
              source: { type: "string", enum: ["site"] },
              results: { type: "array", items: { $ref: "#/components/schemas/TorrentResult" } },
            } },
            { type: "object", properties: {
              source: { type: "string", enum: ["web"] },
              provider: {
            type: "string",
            enum: ["link", "widget", "google", "searxng"],
            description:
              "'widget' means the response carries no results: the page mounts Google's own Programmable " +
              "Search embed and queries it from the browser. Any provider that is misconfigured or failing " +
              "degrades to 'link' with a reason in `degraded`, so this is never the provider that was asked for.",
          },
          cx: { type: "string", description: "Google engine id; present only when provider is 'widget'." },
              results: { type: "array", items: { $ref: "#/components/schemas/WebSearchResult" } },
              links: { type: "array", items: { type: "object" }, description: "Ready-made link-outs, always present so the widget works with no credentials." },
              degraded: { type: "string", description: "Set when the configured provider failed and only links are being returned." },
            } },
          ] } } } },
          "400": errorResponse("invalid query"),
          "409": errorResponse("the requested source is not configured"),
          "502": errorResponse("source unreachable / blocked (e.g. Cloudflare)"),
        },
      },
    },
    "/api/search/grab": {
      post: {
        summary: "Grab a chosen release and route it to the *arr that should import it",
        description:
          "prowlarr + an *arr target → Prowlarr hands the release to its download client and that *arr " +
          "is nudged to adopt it; prowlarr + qBittorrent → the release's own link is added under " +
          "`torhq-manual`; site → the magnet goes to qBittorrent under the target's category. The *arr " +
          "always owns the import, rename and placement — TorHQ moves no files.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("GrabInput"),
        responses: {
          "200": { description: "Grabbed", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, category: { type: "string" }, via: { type: "string" },
            importTriggered: { type: "boolean", description: "Whether the matching *arr was nudged to import the download." },
          } } } } },
          "400": errorResponse("invalid magnet / missing guid+indexerId / unknown target"),
          "409": errorResponse("the source or qBittorrent is not configured"),
          "502": errorResponse("prowlarr or qBittorrent rejected/unreachable"),
        },
      },
    },
    "/api/identify/status": {
      get: {
        summary: "Which parsers are live, and whether Gemini is configured",
        security: [{ cookieAuth: [] }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/identify/models": {
      get: {
        summary: "The Gemini models this key can actually reach",
        description:
          "Enumerated live rather than hardcoded: model names change faster than a release does, and which " +
          "of them a key may use is a property of the key. Powers the model picker in Services, which falls " +
          "back to a free-text field when this cannot be fetched.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            models: { type: "array", items: { type: "string" } },
            current: { type: "string", description: "The model currently configured (or the default)." },
          } } } } },
          "409": errorResponse("Gemini is not configured"),
          "502": errorResponse("the key was rejected, or Google is unreachable"),
        },
      },
    },
    "/api/identify": {
      post: {
        summary: "Identify one raw torrent release name",
        description:
          "Three rungs, cheapest and most authoritative first: (1) each *arr's own /parse - free, " +
          "deterministic, and the same parser that performs imports, so a library match is a guarantee; " +
          "(2) a parse that read the name but matched nothing becomes a lookup term; (3) Gemini, ONLY for " +
          "names no parser could read, and only when configured. The model never decides what something " +
          "is - it produces a search term, the *arr's lookup produces candidates, and a person confirms. " +
          "A POST behind CSRF rather than a GET because rung 3 can spend money.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("IdentifyInput"),
        responses: {
          "200": jsonOk("Identification"),
          "400": errorResponse("invalid body"),
        },
      },
    },
    "/api/identify/batch": {
      post: {
        summary: "Identify a page of release names in one request",
        description:
          "Names are de-duplicated and answers cached for 30 minutes per exact release name, so a " +
          "re-render or a second look at the same search costs nothing. Capped at 30 names per request, " +
          "which is what stops a careless or crafted call becoming a hundred model invocations.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("IdentifyBatchInput"),
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            results: { type: "array", items: { $ref: "#/components/schemas/Identification" } },
          } } } } },
          "400": errorResponse("invalid body, or more than 30 releases"),
        },
      },
    },
    "/api/acquire/lookup": {
      get: {
        summary: "Find a title across the Radarr, Sonarr and Lidarr lookups at once",
        description:
          "Step 1 of the acquisition loop. One query fans out to all three *arr lookups - a term like " +
          "'dune' is legitimately a film and a series - and each candidate carries the service it belongs " +
          "to. An *arr that is down or unconfigured is listed in `unavailable`, never silently omitted.",
        security: [{ cookieAuth: [] }],
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", maxLength: 256 } }],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            candidates: { type: "array", items: { $ref: "#/components/schemas/AcquireCandidate" } },
            unavailable: { type: "array", items: { type: "object", properties: {
              service: { $ref: "#/components/schemas/ArrService" }, detail: { type: "string" },
            } } },
          } } } } },
          "400": errorResponse("invalid query"),
        },
      },
    },
    "/api/drives": {
      get: {
        summary: "Configured drives with their free space, and the default drive per kind of content",
        security: [{ cookieAuth: [] }],
        responses: { "200": jsonOk("DriveSettings", "OK"), "403": errorResponse("admin only") },
      },
      put: {
        summary: "Replace the drive configuration",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("DriveSettings"),
        responses: {
          "200": jsonOk("DriveSettings", "Saved"),
          "400": errorResponse("a path on two drives, an unknown default, or a relative path"),
        },
      },
    },
    "/api/acquire/defaults": {
      get: {
        summary: "Saved placement defaults per *arr, plus the live options they are chosen from",
        security: [{ cookieAuth: [] }],
        responses: { "200": { description: "OK" } },
      },
      put: {
        summary: "Save one *arr's default root folder and quality profile",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("AcquireDefaultsInput"),
        responses: {
          "200": jsonOk("Ok", "Saved"),
          "400": errorResponse("invalid body"),
          "409": errorResponse("that *arr is not configured"),
        },
      },
    },
    "/api/acquire/prepare": {
      post: {
        summary: "Ensure the chosen title exists in its *arr, and return its library id",
        description:
          "Step 2, and the join that makes the whole loop work: an *arr will not import a download for " +
          "something that is not in its library. Idempotent - a title already present returns its existing " +
          "id rather than duplicating. Adds monitored but does NOT start an automatic search, so the *arr " +
          "never races the user to grab something they did not pick. With no saved defaults it falls back " +
          "to the *arr's first root folder and quality profile, and the response says which were used.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("AcquirePrepareInput"),
        responses: {
          "200": { description: "Prepared", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, id: { type: "integer" }, title: { type: "string" },
            service: { $ref: "#/components/schemas/ArrService" },
            rootFolderPath: { type: "string" }, qualityProfileId: { type: "integer" },
            metadataProfileId: { type: "integer" },
          } } } } },
          "400": errorResponse("invalid body"),
          "409": errorResponse("that *arr is not configured, or has no root folder / quality profile"),
          "502": errorResponse("the *arr rejected the add, or the candidate is no longer available"),
        },
      },
    },
    "/api/acquire/targets": {
      get: {
        summary: "What can be searched within a prepared title (Sonarr seasons, Lidarr albums)",
        description: "Radarr answers kind 'none' - a movie is the unit of search.",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "service", in: "query", required: true, schema: { $ref: "#/components/schemas/ArrService" } },
          { name: "id", in: "query", required: true, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "OK" },
          "409": errorResponse("that *arr is not configured"),
          "502": errorResponse("the *arr is unreachable"),
        },
      },
    },
    "/api/acquire/search": {
      post: {
        summary: "Start the *arr's own interactive search for releases",
        description:
          "Step 3. Returns a job token immediately rather than a result: the *arr queries every indexer in " +
          "series and routinely runs for one to three minutes, which no browser request should hold open. " +
          "Poll GET /api/acquire/search/{id}. Jobs are in-memory and expire 15 minutes after finishing.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("AcquireSearchInput"),
        responses: {
          "200": jsonOk("AcquireSearchJob", "Search started"),
          "400": errorResponse("invalid body, or a Sonarr search with no seasonNumber"),
          "409": errorResponse("that *arr is not configured"),
        },
      },
    },
    "/api/acquire/search/{id}": {
      get: {
        summary: "Poll a release search",
        security: [{ cookieAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": jsonOk("AcquireSearchJob"),
          "404": errorResponse("no such search - most likely it expired; run it again"),
        },
      },
    },
    "/api/acquire/grab": {
      post: {
        summary: "Grab the chosen release through the *arr, so the *arr imports and files it",
        description:
          "Step 4, and the reason the content ends up in the right folder: the release goes into that *arr's " +
          "own queue and download client, so the *arr tracks it, imports it on completion, renames it, and " +
          "places it under its root folder. TorHQ never touches the file. A release the quality profile " +
          "rejected can still be grabbed - a deliberate override, recorded as such in the activity log.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("AcquireGrabInput"),
        responses: {
          "200": jsonOk("Ok", "The *arr accepted the release"),
          "400": errorResponse("invalid body"),
          "409": errorResponse("that *arr is not configured"),
          "502": errorResponse("the *arr refused the release or is unreachable"),
        },
      },
    },
    "/api/intake/preview": {
      post: {
        summary: "Dry-run preview of a manual intake",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("IntakeInput"),
        responses: { "200": jsonOk("IntakePreview"), "400": errorResponse("path validation failed"), "422": errorResponse("unprocessable") },
      },
    },
    "/api/intake": {
      post: {
        summary: "Enqueue a manual intake job",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("IntakeInput"),
        responses: {
          "200": { description: "Queued", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, jobId: { type: "string" }, status: { type: "string" },
          } } } } },
          "400": errorResponse("path validation failed"),
        },
      },
    },
    "/api/jobs": {
      get: {
        summary: "List jobs",
        parameters: [{
          name: "status", in: "query",
          schema: { type: "string", enum: ["queued", "running", "completed", "failed", "dead"] },
          description: "An unknown status is rejected, not treated as a filter that matches nothing.",
        }],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            jobs: { type: "array", items: { $ref: "#/components/schemas/Job" } },
          } } } } },
          "400": errorResponse("unknown status"),
        },
      },
    },
    "/api/jobs/{id}": {
      get: {
        summary: "Job detail + activity",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" }, "404": errorResponse("not found") },
      },
    },
    "/api/jobs/{id}/retry": {
      post: {
        summary: "Retry a job",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader, { name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": jsonOk("Ok"), "404": errorResponse("not found") },
      },
    },
    "/api/activity": {
      get: {
        summary: "Global activity timeline",
        parameters: [{
          name: "limit", in: "query", required: false,
          schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          description: "Rejected outside 1-500 rather than clamped, so a caller is never quietly given something other than what it asked for.",
        }],
        responses: { "200": { description: "OK" }, "400": errorResponse("limit out of range or not a number") },
      },
    },
    "/api/downloads": {
      get: {
        summary: "Every torrent in qBittorrent, with the global transfer rates and category map",
        responses: { "200": { description: "OK" }, "409": errorResponse("qbittorrent not configured"), "502": errorResponse("qBittorrent unreachable") },
      },
    },
    "/api/downloads/action": {
      post: {
        summary: "Act on one or more torrents",
        description:
          "`deleteWithFiles` is the only action that destroys data on disk; every action is recorded " +
          "in the activity log with the affected torrent names.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("DownloadAction"),
        responses: {
          "200": { description: "Applied", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, action: { type: "string" }, count: { type: "integer" },
          } } } } },
          "400": errorResponse("invalid action / hashes"),
          "409": errorResponse("qbittorrent not configured"),
          "502": errorResponse("qBittorrent rejected the action"),
        },
      },
    },
    "/api/queue": {
      get: {
        summary: "The merged Radarr/Sonarr/Lidarr queue",
        description:
          "A service that is missing or down is reported in `unavailable` and never fails the whole " +
          "response — a broken Lidarr must not hide what Radarr is doing.",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/queue/refresh": {
      post: {
        summary: "Ask every configured *arr to poll its download client now",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/queue/{service}/{id}/remove": {
      post: {
        summary: "Drop one record from an *arr's queue",
        description: "Downloaded files are left on disk either way; both switches are the caller's explicit choice and both are logged.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          csrfHeader,
          { name: "service", in: "path", required: true, schema: { type: "string", enum: ["radarr", "sonarr", "lidarr"] } },
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
        ],
        requestBody: jsonBody("QueueRemoveInput"),
        responses: {
          "200": jsonOk("Ok", "Removed"),
          "409": errorResponse("that *arr is not configured"),
          "502": errorResponse("the *arr rejected the removal"),
        },
      },
    },
    "/api/pipeline/check": {
      get: {
        summary: "Read-only verification of the grab → download → import path",
        description:
          "Reports concrete mismatches with a fix. TorHQ never repairs one silently — a check that " +
          "fails tells you what to change, it does not change it.",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            checks: { type: "array", items: { $ref: "#/components/schemas/PipelineCheck" } },
          } } } } },
        },
      },
    },
    "/api/pipeline/failed-imports": {
      get: {
        summary: "Downloads an *arr finished but could not import",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/pipeline/manual-import": {
      post: {
        summary: "Ask the owning *arr to scan a completed download again",
        description:
          "The *arr does the scanning, moving and renaming; TorHQ only points it at that *arr's own " +
          "output path for a download it already owns.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("ManualImportInput"),
        responses: {
          "200": { description: "Requested", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, service: { type: "string" }, command: { type: "string" }, path: { type: ["string", "null"] },
          } } } } },
          "404": errorResponse("that *arr has no queue item for the given downloadId"),
          "409": errorResponse("that *arr is not configured"),
          "502": errorResponse("the *arr rejected the rescan"),
        },
      },
    },
    "/api/status/health": { get: { summary: "Aggregate service health", responses: { "200": { description: "OK" } } } },
    "/api/status/downloads": { get: { summary: "qBittorrent downloads by category", responses: { "200": { description: "OK" }, "409": errorResponse("qbittorrent not configured") } } },
    "/api/status/arr-activity": { get: { summary: "Recent Radarr/Sonarr/Lidarr activity", responses: { "200": { description: "OK" } } } },
    "/api/status/slskd": { get: { summary: "Recent slskd downloads", responses: { "200": { description: "OK" }, "409": errorResponse("slskd not configured") } } },
    "/api/status/failures": { get: { summary: "Failed imports + retry queue", responses: { "200": { description: "OK" } } } },
    "/api/status/storage": { get: { summary: "Storage usage for approved roots", responses: { "200": { description: "OK" } } } },
    "/api/status/mounts": {
      get: {
        summary: "NFS/SMB network mounts visible in this container (read-only)",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            mounts: { type: "array", items: { type: "object", properties: {
              target: { type: "string" }, source: { type: "string" }, fstype: { type: "string" },
              totalBytes: { type: "integer" }, freeBytes: { type: "integer" },
            } } },
          } } } } },
        },
      },
    },
    "/api/catalogue/sources": {
      get: {
        summary: "Which catalogue kinds (movie, tv, game) can be browsed, their lists, and the game platform filters",
        description: "Film and TV come from TMDB, games from RAWG. A kind whose source has no API key is reported with the reason.",
        security: [{ cookieAuth: [] }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/catalogue/genres": {
      get: {
        summary: "Genres a kind can be filtered by (TMDB genre ids, or RAWG slugs for games)",
        security: [{ cookieAuth: [] }],
        parameters: [{ name: "kind", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv", "game"] } }],
        responses: {
          "200": { description: "OK" },
          "409": errorResponse("the source for this kind is not configured"),
          "502": errorResponse("the source rejected the key or is unreachable"),
        },
      },
    },
    "/api/catalogue/browse": {
      get: {
        summary: "One page of a catalogue list, or of a title search when `q` is given",
        description:
          "Read-only. Movies and shows already in Radarr/Sonarr are marked `inLibrary` (`libraryChecked` is false " +
          "when that could not be determined). A movie carries `selectionId` (`tmdb:<id>`), which the Get and " +
          "Requests flows accept directly.",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "kind", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv", "game"] } },
          { name: "list", in: "query", schema: { type: "string", enum: ["trending", "popular", "top_rated", "upcoming", "now_playing", "on_the_air", "new"] } },
          { name: "q", in: "query", schema: { type: "string", maxLength: 256 } },
          { name: "genre", in: "query", schema: { type: "string" } },
          { name: "platform", in: "query", schema: { type: "integer" }, description: "Games only: a RAWG parent-platform id." },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } },
        ],
        responses: {
          "200": { description: "OK" },
          "400": errorResponse("invalid query, or a list that kind does not have"),
          "409": errorResponse("the source for this kind is not configured"),
          "502": errorResponse("the source rejected the key or is unreachable"),
        },
      },
    },
    "/api/catalogue/details": {
      get: {
        summary: "Full detail for one title, including a show's `tvdb:<id>` selection id",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "kind", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv", "game"] } },
          { name: "id", in: "query", required: true, schema: { type: "string", pattern: "^\\d+$" } },
        ],
        responses: {
          "200": { description: "OK" },
          "409": errorResponse("the source for this kind is not configured"),
          "502": errorResponse("the source rejected the key or is unreachable"),
        },
      },
    },
    "/webhooks/slskd": {
      post: {
        summary: "slskd completed-download webhook (shared-token auth)",
        security: [],
        parameters: [{ name: "X-TorHQ-Token", in: "header", required: true, schema: { type: "string" } }],
        requestBody: jsonBody("SlskdWebhook"),
        responses: { "200": { description: "queued" }, "401": errorResponse("invalid webhook token"), "409": errorResponse("library not configured") },
      },
    },
    "/metrics": { get: { summary: "Prometheus metrics (if enabled)", security: [], responses: { "200": { description: "OK" } } } },
  },
} as const;

export function openApiRoutes(app: FastifyInstance): void {
  app.get("/api/openapi.json", async () => openApiDoc);
}
