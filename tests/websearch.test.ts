import { describe, it, expect } from "vitest";
import { WebSearchAdapter, buildLinks } from "../server/src/adapters/websearch.js";

const adapter = (extra: Record<string, unknown>) =>
  new WebSearchAdapter({ baseUrl: "", secret: "", extra });

describe("the Google widget provider", () => {
  // The widget's whole point: no server call, so nothing here can be slow,
  // rate-limited, or dependent on a key. These tests make no network requests
  // and would hang or fail if the adapter started making one.
  it("hands the engine id to the page instead of searching", async () => {
    const res = await adapter({ provider: "widget", googleCx: "abc123" }).search("dune 1984");
    expect(res.provider).toBe("widget");
    expect(res.cx).toBe("abc123");
    expect(res.results).toEqual([]); // the browser fetches them, not TorHQ
    expect(res.degraded).toBeUndefined();
  });

  it("still returns the open-in-a-tab links, so the card is never empty", async () => {
    const res = await adapter({ provider: "widget", googleCx: "abc123" }).search("dune");
    expect(res.links.map((l) => l.label)).toContain("Google");
  });

  it("degrades to links when no engine id is configured", async () => {
    const res = await adapter({ provider: "widget" }).search("dune");
    expect(res.provider).toBe("link");
    expect(res.cx).toBeUndefined();
    expect(res.degraded).toMatch(/search-engine id/i);
    expect(res.links.length).toBeGreaterThan(0);
  });

  it("reports health without probing anything", async () => {
    await expect(adapter({ provider: "widget", googleCx: "abc" }).health())
      .resolves.toMatchObject({ healthy: true });
    await expect(adapter({ provider: "widget" }).health())
      .resolves.toMatchObject({ healthy: false });
  });

  it("does not leak the engine id on providers that do not use it", async () => {
    const link = await adapter({ provider: "link", googleCx: "abc123" }).search("dune");
    expect(link.provider).toBe("link");
    expect(link.cx).toBeUndefined();
  });

  it("falls back to links rather than the widget for an unknown provider", async () => {
    const res = await adapter({ provider: "bing", googleCx: "abc123" }).search("dune");
    expect(res.provider).toBe("link");
  });
});

describe("link templates", () => {
  it("always offers Google first", () => {
    expect(buildLinks("the thing")[0]).toMatchObject({ label: "Google" });
    expect(buildLinks("the thing")[0].url).toContain("the%20thing");
  });

  // These URLs go straight into an href, so a non-http scheme surviving here
  // would be a stored-XSS vector via the service config.
  it("drops a javascript: template instead of rendering it", () => {
    const links = buildLinks("x", "Evil|javascript:alert(1)\nOk|https://example.com/s?q={q}");
    expect(links.map((l) => l.label)).toEqual(["Google", "Ok"]);
  });

  it("ignores malformed lines without dropping the good ones", () => {
    const links = buildLinks("x", "no-pipe-here\n|missing-label\nGood|https://e.com/{q}\n");
    expect(links.map((l) => l.label)).toEqual(["Google", "Good"]);
  });

  it("caps how many shortcuts a pasted config can add", () => {
    const many = Array.from({ length: 40 }, (_, i) => `L${i}|https://e.com/?q={q}`).join("\n");
    expect(buildLinks("x", many).length).toBeLessThanOrEqual(12);
  });

  it("fills every {q} placeholder in a template, not just the first", () => {
    const links = buildLinks("dune", "Example|https://x.test/?a={q}&b={q}");
    expect(links).toContainEqual({ label: "Example", url: "https://x.test/?a=dune&b=dune" });
  });
});
