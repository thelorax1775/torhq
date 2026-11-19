import { describe, it, expect, vi, beforeEach } from "vitest";

const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => s,
}));

const { GeminiAdapter, parseGuess, geminiMessage } = await import("../server/src/adapters/gemini.js");

const cfg = { baseUrl: "", secret: "TESTKEY" };

/** A generateContent response carrying `obj` as the model's JSON answer. */
const reply = (obj: unknown) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

beforeEach(() => httpJson.mockReset());

describe("GeminiAdapter wiring", () => {
  it("sends the key as a header, never in the URL", async () => {
    // Query strings end up in logs and proxies; an API key must not.
    httpJson.mockResolvedValueOnce({ models: [] });
    await new GeminiAdapter(cfg).models().catch(() => {});
    const [, path, opts] = httpJson.mock.calls[0];
    expect(opts.headers).toEqual({ "x-goog-api-key": "TESTKEY" });
    expect(path).not.toContain("TESTKEY");
    expect(JSON.stringify(opts.query ?? {})).not.toContain("TESTKEY");
  });

  it("falls back to Google's endpoint when no base URL is configured", async () => {
    httpJson.mockResolvedValueOnce({ models: [] });
    await new GeminiAdapter({ baseUrl: "  ", secret: "k" }).models();
    expect(httpJson.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com");
  });

  it("uses the configured model, and a sane default without one", () => {
    // The default is an ALIAS on purpose: a pinned version goes stale, and
    // gemini-2.5-flash is already refused for new keys.
    expect(new GeminiAdapter(cfg).model).toBe("gemini-flash-latest");
    expect(new GeminiAdapter({ ...cfg, extra: { model: "gemini-3-pro" } }).model).toBe("gemini-3-pro");
    // A blank field means "the default", not a request for a model named "".
    expect(new GeminiAdapter({ ...cfg, extra: { model: "   " } }).model).toBe("gemini-flash-latest");
  });

  it("asks for deterministic, schema-constrained JSON", async () => {
    httpJson.mockResolvedValueOnce(reply({ kind: "movie", title: "Dune", confidence: 0.9 }));
    await new GeminiAdapter(cfg).identify("Dune.2021.1080p");
    const opts = httpJson.mock.calls[0][2];
    expect(opts.method).toBe("POST");
    // Identification is not creative: the same name must give the same answer.
    expect(opts.body.generationConfig.temperature).toBe(0);
    expect(opts.body.generationConfig.responseMimeType).toBe("application/json");
    expect(opts.body.generationConfig.responseSchema).toBeDefined();
  });
});

describe("GeminiAdapter.health", () => {
  it("gives the model-list probe a short timeout so a dead provider cannot stall the health call", async () => {
    httpJson.mockResolvedValueOnce({ models: [] });
    await new GeminiAdapter(cfg).health();
    expect(httpJson.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(8_000);
  });

  it("names a configured model the key cannot actually reach", async () => {
    // Otherwise this is a cheerful "healthy" that 404s on the first real call.
    httpJson.mockResolvedValueOnce({
      models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
    });
    const h = await new GeminiAdapter({ ...cfg, extra: { model: "gemini-9-imaginary" } }).health();
    expect(h.healthy).toBe(false);
    expect(h.detail).toMatch(/not available to this key/);
    expect(h.detail).toMatch(/gemini-2\.5-flash/); // and says what it could use
    // Rejected from the list alone -- no point spending a call on it.
    expect(httpJson).toHaveBeenCalledTimes(1);
  });

  it("is healthy only once the model has actually answered", async () => {
    httpJson
      .mockResolvedValueOnce({ models: [
        { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      ] })
      .mockResolvedValueOnce(reply({ kind: "movie", title: "Probe", confidence: 0.9 }));
    const h = await new GeminiAdapter(cfg).health();
    expect(h.healthy).toBe(true);
    expect(h.version).toBe("gemini-flash-latest");
    expect(h.detail).toMatch(/answered/);
    // Listing alone is not the check: it must have made the real call too.
    expect(httpJson).toHaveBeenCalledTimes(2);
  });

  it("is UNHEALTHY when the model is listed but refuses the call", async () => {
    // The live failure this check exists for: gemini-2.5-flash appears in
    // ListModels and answers generateContent with "no longer available to new
    // users". Reporting that as healthy is worse than reporting nothing.
    const { HttpError } = await import("../server/src/adapters/http.js");
    httpJson
      .mockResolvedValueOnce({ models: [{ name: "models/gemini-flash-latest" }] })
      .mockRejectedValueOnce(new HttpError("HTTP 404", 404, JSON.stringify({
        error: { message: "This model models/x is no longer available to new users.", status: "NOT_FOUND" },
      })));
    const h = await new GeminiAdapter(cfg).health();
    expect(h.healthy).toBe(false);
    expect(h.detail).toMatch(/listed but will not answer/);
    expect(h.detail).toMatch(/no longer available to new users/);
  });

  it("ignores models that cannot answer a generateContent call", async () => {
    // An embedding model is not a usable model here, so a key that can reach
    // only those has none — and says so, rather than naming an alternative it
    // does not in fact have.
    httpJson.mockResolvedValueOnce({
      models: [{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }],
    });
    const h = await new GeminiAdapter(cfg).health();
    expect(h.healthy).toBe(false);
    expect(h.detail).toMatch(/can use no models/);
  });

  it("counts a model that does not declare its methods as usable", async () => {
    // Older list responses omit supportedGenerationMethods; treating that as
    // "unusable" would report a working key as broken.
    httpJson
      .mockResolvedValueOnce({ models: [{ name: "models/gemini-flash-latest" }] })
      .mockResolvedValueOnce(reply({ kind: "movie", title: "Probe", confidence: 0.9 }));
    expect((await new GeminiAdapter(cfg).health()).healthy).toBe(true);
  });
});

describe("parseGuess — the model's answer is validated, not trusted", () => {
  it("reads a well-formed guess", () => {
    expect(parseGuess(reply({ kind: "tv", title: "Severance", year: 2022, season: 2, confidence: 0.8 })))
      .toMatchObject({ kind: "tv", title: "Severance", year: 2022, season: 2, confidence: 0.8 });
  });

  it("treats an honest 'unknown' as no answer", () => {
    // A refusal is useful. Converting it into a guess would not be.
    expect(parseGuess(reply({ kind: "unknown", title: "something", confidence: 0.9 }))).toBeNull();
  });

  it("rejects an answer with no title", () => {
    expect(parseGuess(reply({ kind: "movie", title: "   ", confidence: 1 }))).toBeNull();
  });

  it("drops an implausible year rather than passing it on", () => {
    expect(parseGuess(reply({ kind: "movie", title: "X", year: 12, confidence: 0.5 }))?.year).toBeUndefined();
  });

  it("turns an unusable confidence into no opinion, never into certainty", () => {
    expect(parseGuess(reply({ kind: "movie", title: "X", confidence: 42 }))?.confidence).toBe(0.5);
    expect(parseGuess(reply({ kind: "movie", title: "X" }))?.confidence).toBe(0.5);
  });

  it("ignores a season on anything that is not TV", () => {
    expect(parseGuess(reply({ kind: "movie", title: "X", season: 3, confidence: 0.9 }))?.season).toBeUndefined();
  });

  it("survives a blocked, empty or non-JSON response", () => {
    expect(parseGuess({ candidates: [] })).toBeNull();
    expect(parseGuess({})).toBeNull();
    expect(parseGuess(null)).toBeNull();
    expect(parseGuess({ candidates: [{ content: { parts: [{ text: "I'm sorry, I can't." }] } }] })).toBeNull();
  });
});

describe("geminiMessage — Google's reason survives a truncated body", () => {
  it("reads the message from a well-formed error envelope", async () => {
    const { HttpError } = await import("../server/src/adapters/http.js");
    const e = new HttpError("HTTP 404", 404, JSON.stringify({
      error: { message: "This model is no longer available to new users.", status: "NOT_FOUND" },
    }));
    expect(geminiMessage(e)).toMatch(/no longer available to new users/);
    expect(geminiMessage(e)).toMatch(/NOT_FOUND/);
  });

  it("still recovers the message when the body was cut mid-JSON", async () => {
    // The live failure: httpJson truncates, JSON.parse then fails, and the only
    // useful part of the response was being discarded in favour of "HTTP 429".
    const { HttpError } = await import("../server/src/adapters/http.js");
    const truncated =
      '{"error":{"code":429,"message":"You exceeded your current quota. Please migrate to Gemini 3.","status":"RESOURCE_EXHAU';
    expect(geminiMessage(new HttpError("HTTP 429", 429, truncated)))
      .toBe("You exceeded your current quota. Please migrate to Gemini 3.");
  });

  it("falls back to the status line rather than dumping an HTML error page", async () => {
    const { HttpError } = await import("../server/src/adapters/http.js");
    const html = "<!doctype html><html>" + "x".repeat(400) + "</html>";
    expect(geminiMessage(new HttpError("HTTP 502", 502, html))).toBe("HTTP 502");
  });
});

describe("parseGuess — thinking models put the answer after their reasoning", () => {
  const guess = { kind: "movie", title: "Amelie", year: 2001, confidence: 0.9 };

  it("skips a thought part and reads the real answer", () => {
    // Gemini 3.x emits reasoning parts alongside the result. Reading parts[0]
    // got the reasoning, failed to parse it, and reported "could not identify"
    // for a release the model had in fact identified.
    const res = { candidates: [{ content: { parts: [
      { text: "The user gave a French film title...", thought: true },
      { text: JSON.stringify(guess) },
    ] } }] };
    expect(parseGuess(res)).toMatchObject({ title: "Amelie", year: 2001 });
  });

  it("finds the answer in a later part even when nothing is flagged as thought", () => {
    const res = { candidates: [{ content: { parts: [
      { text: "Let me think about this." },
      { text: JSON.stringify(guess) },
    ] } }] };
    expect(parseGuess(res)?.title).toBe("Amelie");
  });

  it("recovers a JSON object embedded in prose", () => {
    const res = { candidates: [{ content: { parts: [
      { text: "Here you go:\n```json\n" + JSON.stringify(guess) + "\n```" },
    ] } }] };
    expect(parseGuess(res)?.title).toBe("Amelie");
  });

  it("still returns null when there is genuinely no answer", () => {
    expect(parseGuess({ candidates: [{ content: { parts: [{ text: "I cannot help.", thought: true }] } }] })).toBeNull();
    expect(parseGuess({ candidates: [{ content: { parts: [] } }] })).toBeNull();
  });
});
