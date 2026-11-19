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
