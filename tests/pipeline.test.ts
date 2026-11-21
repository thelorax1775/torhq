import { describe, it, expect } from "vitest";
import {
  buildPipelineChecks, isInside, STUCK_IMPORT_MS,
  type ArrSnapshot, type PipelineCheck, type QbSnapshot,
} from "../server/src/lib/pipeline.js";
import type { ArrDownloadClient, ArrFlavor, ArrQueueItem } from "../server/src/adapters/arr.js";

const NOW = Date.parse("2026-07-25T12:00:00Z");

function qbClient(fields: Record<string, unknown>, over: Partial<ArrDownloadClient> = {}): ArrDownloadClient {
  return { id: 1, name: "qBittorrent", implementation: "QBittorrent", enable: true, fields, ...over };
}

/** A stack where every check passes, so a test only has to state its one defect. */
function healthy(service: ArrFlavor = "radarr", over: Partial<ArrSnapshot> = {}): ArrSnapshot {
  const categoryField = { radarr: "movieCategory", sonarr: "tvCategory", lidarr: "musicCategory" }[service];
  return {
    service,
    configured: true,
    downloadClients: [qbClient({ host: "qbittorrent", port: 8090, [categoryField]: service })],
    config: { enableCompletedDownloadHandling: true },
    rootFolders: [{ id: 1, path: "/mnt/storage/movies", accessible: true }],
    queue: [],
    visiblePaths: [{ path: "/mnt/torrents/radarr", visible: true, parentVisible: true }],
    ...over,
  };
}

const QB: QbSnapshot = {
  configured: true,
  categories: {
    radarr: { name: "radarr", savePath: "/mnt/torrents/radarr" },
    sonarr: { name: "sonarr", savePath: "/mnt/torrents/sonarr" },
    lidarr: { name: "lidarr", savePath: "/mnt/torrents/lidarr" },
  },
  defaultSavePath: "/mnt/torrents",
  torrents: [],
};

const find = (checks: PipelineCheck[], id: string) => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check with id ${id}; got ${checks.map((x) => x.id).join(", ")}`);
  return c;
};

const run = (arr: ArrSnapshot, qb: QbSnapshot = QB) =>
  buildPipelineChecks({ qb, arrs: [arr], now: NOW });

describe("a fully wired stack", () => {
  it("passes every check", () => {
    const checks = run(healthy());
    const failed = checks.filter((c) => !c.ok);
    expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
  });

  it("never omits a fix from a failing check", () => {
    const checks = buildPipelineChecks({
      qb: { configured: false },
      arrs: [{ service: "radarr", configured: true, error: "ECONNREFUSED" }],
      now: NOW,
    });
    for (const c of checks.filter((x) => !x.ok)) expect(c.fix, c.id).toBeTruthy();
  });
});

describe("download-client category", () => {
  // Regression: reading only `fields.category` reported a correctly-configured
  // stack as broken, because each *arr names the field after its media type.
  it.each([
    ["radarr", "movieCategory"],
    ["sonarr", "tvCategory"],
    ["lidarr", "musicCategory"],
  ] as const)("reads %s's category from %s", (service, field) => {
    const arr = healthy(service, {
      downloadClients: [qbClient({ [field]: service })],
      visiblePaths: [{ path: "/mnt/torrents/radarr", visible: true, parentVisible: true }],
    });
    const check = find(run(arr), `qb-category-${service}`);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain(service);
  });

  it("still accepts a plain `category` field", () => {
    const arr = healthy("radarr", { downloadClients: [qbClient({ category: "radarr" })] });
    expect(find(run(arr), "qb-category-radarr").ok).toBe(true);
  });

  it("fails when no category is set at all", () => {
    const arr = healthy("radarr", { downloadClients: [qbClient({ host: "qbittorrent" })] });
    const check = find(run(arr), "qb-category-radarr");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("error");
  });

  it("fails when the category does not exist in qBittorrent", () => {
    const arr = healthy("radarr", { downloadClients: [qbClient({ movieCategory: "films" })] });
    const check = find(run(arr), "qb-category-radarr");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("films");
  });
});

describe("save-path visibility", () => {
  // The failure that produces no error anywhere: settings agree, the directory
  // simply is not mounted in the *arr's container.
  it("fails, loudly, when the download directory is not mounted at all", () => {
    const arr = healthy("radarr", {
      visiblePaths: [
        { path: "/mnt/torrents/radarr", visible: false, parentVisible: false },
        { path: "/mnt/torrents", visible: false, parentVisible: false },
      ],
    });
    const check = find(run(arr), "radarr-sees-save-path");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("error");
    expect(check.detail).toContain("/mnt/torrents/radarr");
    expect(check.fix).toContain("pct set");
  });

  // Regression: a category's save path only exists once a torrent lands in it,
  // so a freshly-created category looked exactly like an unmounted volume.
  it("passes when a category directory does not exist yet but its parent is visible", () => {
    const arr = healthy("radarr", {
      visiblePaths: [
        { path: "/mnt/torrents", visible: true, parentVisible: true },
        { path: "/mnt/torrents/radarr", visible: false, parentVisible: true },
      ],
    });
    const check = find(run(arr), "radarr-sees-save-path");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("does not exist yet");
    expect(check.detail).toContain("/mnt/torrents/radarr");
  });

  it("still fails when one path is genuinely unmounted among others that are fine", () => {
    const arr = healthy("radarr", {
      visiblePaths: [
        { path: "/mnt/torrents/radarr", visible: true, parentVisible: true },
        { path: "/mnt/torrents2", visible: false, parentVisible: false },
      ],
    });
    // Radarr's category lives on a second, unmounted volume; the default path is fine.
    const qb: QbSnapshot = {
      ...QB, categories: { ...QB.categories, radarr: { name: "radarr", savePath: "/mnt/torrents2" } },
    };
    const check = find(run(arr, qb), "radarr-sees-save-path");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("/mnt/torrents2");
    expect(check.detail).not.toContain("/mnt/torrents/radarr");
  });

  it("reports unknown rather than broken when the browse call failed", () => {
    const check = find(run(healthy("radarr", { visiblePaths: undefined })), "radarr-sees-save-path");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn"); // not an error: we did not learn anything
  });

  it("does not claim a problem when qBittorrent has no known save path", () => {
    const qb: QbSnapshot = { configured: true, categories: {}, torrents: [] };
    const check = find(run(healthy("radarr", { visiblePaths: [] }), qb), "radarr-sees-save-path");
    expect(check.severity).toBe("info");
  });
});

describe("download client", () => {
  it("fails when there is no qBittorrent client", () => {
    const check = find(run(healthy("radarr", { downloadClients: [] })), "radarr-download-client");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("error");
  });

  it("fails when the qBittorrent client exists but is disabled", () => {
    const arr = healthy("radarr", {
      downloadClients: [qbClient({ movieCategory: "radarr" }, { enable: false })],
    });
    const check = find(run(arr), "radarr-download-client");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("disabled");
  });

  it("prefers the enabled client when several are present", () => {
    const arr = healthy("radarr", {
      downloadClients: [
        qbClient({ movieCategory: "stale" }, { id: 1, name: "old", enable: false }),
        qbClient({ movieCategory: "radarr" }, { id: 2, name: "current", enable: true }),
      ],
    });
    expect(find(run(arr), "radarr-download-client").detail).toContain("current");
    expect(find(run(arr), "qb-category-radarr").ok).toBe(true);
  });
});

describe("root folders", () => {
  it("fails when a root folder is inside qBittorrent's download directory", () => {
    const arr = healthy("radarr", {
      rootFolders: [{ id: 1, path: "/mnt/torrents/radarr/movies", accessible: true }],
    });
    const check = find(run(arr), "radarr-root-folder");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("seeded");
  });

  it("fails when the *arr reports a root folder as inaccessible", () => {
    const arr = healthy("radarr", {
      rootFolders: [{ id: 1, path: "/mnt/storage/movies", accessible: false }],
    });
    expect(find(run(arr), "radarr-root-folder").ok).toBe(false);
  });

  it("fails when there is no root folder at all", () => {
    expect(find(run(healthy("radarr", { rootFolders: [] })), "radarr-root-folder").ok).toBe(false);
  });
});

describe("stuck imports", () => {
  const item = (over: Partial<ArrQueueItem> = {}): ArrQueueItem => ({
    service: "radarr", id: 1, title: "Some Movie", status: "completed",
    trackedDownloadState: "importPending", statusMessages: [], size: 100, sizeleft: 0,
    added: new Date(NOW - 3 * STUCK_IMPORT_MS).toISOString(), ...over,
  });

  it("flags an item that has been importing for over an hour", () => {
    const check = find(run(healthy("radarr", { queue: [item()] })), "radarr-stuck-imports");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Some Movie");
  });

  it("measures import waiting from when the download finished, not when it was grabbed", () => {
    const imported = item({ downloadId: "AAAA" });
    const recent = run(healthy("radarr", { queue: [imported] }), {
      ...QB,
      torrents: [{ hash: "aaaa", name: "Some Movie", category: "radarr", state: "uploading", progress: 1, dlspeed: 0, upspeed: 1, size: 100, eta: 0, savePath: "/mnt/torrents/radarr", contentPath: "/mnt/torrents/radarr/Some Movie", ratio: 1, addedOn: (NOW - 3 * STUCK_IMPORT_MS) / 1000, tags: [], completionOn: (NOW - 5 * 60_000) / 1000 }],
    });
    expect(find(recent, "radarr-stuck-imports").ok).toBe(true);
    const old = run(healthy("radarr", { queue: [imported] }), {
      ...QB,
      torrents: [{ hash: "aaaa", name: "Some Movie", category: "radarr", state: "uploading", progress: 1, dlspeed: 0, upspeed: 1, size: 100, eta: 0, savePath: "/mnt/torrents/radarr", contentPath: "/mnt/torrents/radarr/Some Movie", ratio: 1, addedOn: (NOW - 3 * STUCK_IMPORT_MS) / 1000, tags: [], completionOn: (NOW - 2 * STUCK_IMPORT_MS) / 1000 }],
    });
    expect(find(old, "radarr-stuck-imports").ok).toBe(false);
  });

  it("leaves a recent import alone", () => {
    const recent = item({ added: new Date(NOW - 60_000).toISOString() });
    expect(find(run(healthy("radarr", { queue: [recent] })), "radarr-stuck-imports").ok).toBe(true);
  });

  it("does not call an item of unknown age stuck", () => {
    const undated = item({ added: undefined, downloadId: "nosuchhash" });
    expect(find(run(healthy("radarr", { queue: [undated] })), "radarr-stuck-imports").ok).toBe(true);
  });

  it("ignores an item that is downloading rather than importing", () => {
    const downloading = item({ trackedDownloadState: "downloading" });
    expect(find(run(healthy("radarr", { queue: [downloading] })), "radarr-stuck-imports").ok).toBe(true);
  });
});

describe("degraded services", () => {
  it("treats an unconfigured *arr as information, not a fault", () => {
    const checks = run({ service: "lidarr", configured: false });
    const check = find(checks, "lidarr-configured");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("info"); // a homelab without music has no Lidarr
  });

  it("reports an unreachable *arr once, not as six separate failures", () => {
    const checks = run({ service: "radarr", configured: true, error: "connect ECONNREFUSED" });
    // qb-reachable plus exactly one radarr check.
    expect(checks.filter((c) => c.id.startsWith("radarr-"))).toHaveLength(1);
    expect(find(checks, "radarr-reachable").detail).toContain("ECONNREFUSED");
  });

  it("cannot verify anything downstream when qBittorrent is unconfigured", () => {
    const check = find(buildPipelineChecks({ qb: { configured: false }, arrs: [], now: NOW }), "qb-reachable");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("error");
  });
});

describe("isInside", () => {
  it("matches a path against its own prefix directory", () => {
    expect(isInside("/mnt/torrents/radarr", "/mnt/torrents")).toBe(true);
    expect(isInside("/mnt/torrents", "/mnt/torrents")).toBe(true);
    expect(isInside("/mnt/torrents/", "/mnt/torrents")).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as nested", () => {
    expect(isInside("/mnt/torrents2", "/mnt/torrents")).toBe(false);
    expect(isInside("/mnt/torrentsfoo/x", "/mnt/torrents")).toBe(false);
  });

  it("refuses empty paths rather than matching everything", () => {
    expect(isInside("", "/mnt")).toBe(false);
    expect(isInside("/mnt", "")).toBe(false);
  });
});

describe("save-path visibility is scoped to the categories an *arr uses", () => {
  const withBooks: QbSnapshot = {
    ...QB,
    categories: {
      ...QB.categories,
      "torhq-books": { name: "torhq-books", savePath: "/mnt/torrents/torhq-books" },
      "torhq-audiobooks": { name: "torhq-audiobooks", savePath: "/mnt/torrents/torhq-audiobooks" },
    },
  };

  it("does not call a missing TorHQ book directory a Radarr mount failure", () => {
    const radarr = healthy("radarr", {
      visiblePaths: [
        { path: "/mnt/torrents/radarr", visible: true, parentVisible: true },
        { path: "/mnt/torrents", visible: true, parentVisible: true },
        { path: "/mnt/torrents/torhq-books", visible: false, parentVisible: false },
        { path: "/mnt/torrents/torhq-audiobooks", visible: false, parentVisible: false },
      ],
    });
    const c = find(run(radarr, withBooks), "radarr-sees-save-path");
    expect(c.ok).toBe(true);
    expect(c.detail).not.toContain("torhq-");
  });

  it("still fails when the *arr's own category directory is not mounted", () => {
    const radarr = healthy("radarr", {
      visiblePaths: [
        { path: "/mnt/torrents/radarr", visible: false, parentVisible: false },
        { path: "/mnt/torrents/torhq-books", visible: true, parentVisible: true },
      ],
    });
    const c = find(run(radarr, withBooks), "radarr-sees-save-path");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("/mnt/torrents/radarr");
  });
});
