import { describe, it, expect, vi, beforeEach } from "vitest";

const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => s,
}));

const { QbittorrentAdapter } = await import("../server/src/adapters/qbittorrent.js");

beforeEach(() => httpJson.mockReset());

describe("QbittorrentAdapter.health version", () => {
  it("strips the leading v qBittorrent already reports (UI adds its own)", async () => {
    httpJson.mockResolvedValue("v5.3.0");
    const adapter = new QbittorrentAdapter({ baseUrl: "http://qb:8080", secret: "u:p" } as never);
    // Skip the login round-trip: only the version shape is under test.
    (adapter as unknown as { authed: () => Promise<string> }).authed = async () => "v5.3.0";
    const h = await adapter.health();
    expect(h.healthy).toBe(true);
    expect(h.version).toBe("5.3.0");
  });
});

describe("QbittorrentAdapter.torrents activity timestamps", () => {
  it("maps completion_on and last_activity, treating non-positive activity as zero", async () => {
    httpJson.mockResolvedValue([{
      hash: "aaaa", name: "Dune", category: "radarr", state: "uploading", progress: 1,
      dlspeed: 0, upspeed: 1, size: 100, eta: 0, save_path: "/d", ratio: 1,
      added_on: 1699999999, tags: "", completion_on: 1700000000, last_activity: -1,
    }]);
    const adapter = new QbittorrentAdapter({ baseUrl: "http://qb:8080", secret: "u:p" } as never);
    (adapter as unknown as { cookie: string }).cookie = "SID=test";
    const torrents = await adapter.torrents();
    expect(httpJson).toHaveBeenCalledWith("http://qb:8080", "/api/v2/torrents/info", expect.anything());
    expect(torrents[0]).toMatchObject({ completionOn: 1700000000, lastActivity: 0 });
  });
});
