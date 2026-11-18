import { describe, it, expect, vi, beforeEach } from "vitest";

const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => "Basic " + s,
}));

const { KavitaAdapter } = await import("../server/src/adapters/kavita.js");
const { CalibreWebAdapter } = await import("../server/src/adapters/calibreweb.js");
const { HttpError } = await import("../server/src/adapters/http.js");

beforeEach(() => httpJson.mockReset());

describe("KavitaAdapter.searchTitles", () => {
  it("authenticates, searches series, and returns distinct names", async () => {
    httpJson
      .mockResolvedValueOnce({ token: "JWT" })
      .mockResolvedValueOnce({ series: [{ name: "Dune", originalName: "Dune", localizedName: "Dune (EN)" }, { name: "Emma" }] });
    const k = new KavitaAdapter({ baseUrl: "http://k", secret: "KEY" });
    expect(await k.searchTitles("dune")).toEqual(["Dune", "Dune (EN)", "Emma"]);
    const [, path, opts] = httpJson.mock.calls[1];
    expect(path).toBe("/api/Search/search");
    expect(opts.query).toEqual({ queryString: "dune" });
    expect(opts.headers.authorization).toBe("Bearer JWT");
  });
  it("re-authenticates once when the JWT has expired", async () => {
    httpJson
      .mockResolvedValueOnce({ token: "OLD" })
      .mockRejectedValueOnce(new HttpError("401", 401))
      .mockResolvedValueOnce({ token: "NEW" })
      .mockResolvedValueOnce({ series: [{ name: "Emma" }] });
    const k = new KavitaAdapter({ baseUrl: "http://k", secret: "KEY" });
    expect(await k.searchTitles("emma")).toEqual(["Emma"]);
    expect(httpJson.mock.calls[3][2].headers.authorization).toBe("Bearer NEW");
  });
});

describe("CalibreWebAdapter", () => {
  const cfg = { baseUrl: "http://cw:8083", secret: "reader:pw" };
  it("health is an authorised OPDS call; a 401 explains OPDS", async () => {
    httpJson.mockResolvedValueOnce("<feed/>");
    expect((await new CalibreWebAdapter(cfg).health()).healthy).toBe(true);
    expect(httpJson.mock.calls[0][1]).toBe("/opds/");
    expect(httpJson.mock.calls[0][2].headers.authorization).toBe("Basic reader:pw");
    httpJson.mockRejectedValueOnce(new HttpError("HTTP 401", 401));
    const bad = await new CalibreWebAdapter(cfg).health();
    expect(bad.healthy).toBe(false);
    expect(bad.detail).toMatch(/OPDS/);
  });
  it("searches OPDS with the term encoded", async () => {
    httpJson.mockResolvedValueOnce("<feed><title>x</title><entry><title>Dune</title></entry></feed>");
    expect(await new CalibreWebAdapter(cfg).searchTitles("dune messiah")).toEqual(["Dune"]);
    expect(httpJson.mock.calls[0][1]).toBe("/opds/search/dune%20messiah");
  });
});
