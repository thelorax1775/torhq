import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Google answers a bad request with a JSON body carrying the real reason —
 * "models/x is not found for API version v1beta, or is not supported for
 * generateContent". The HttpError message is only "HTTP 404 for <url>", which
 * sends the reader hunting for a fault that Google has already named.
 */
export function geminiMessage(e: unknown): string {
  if (e instanceof HttpError && e.body) {
    try {
      const parsed = JSON.parse(e.body) as { error?: { message?: string; status?: string } };
      const msg = parsed.error?.message;
      if (msg) return parsed.error?.status ? `${msg} (${parsed.error.status})` : msg;
    } catch {
      // Still truncated, or not JSON at all. The message field is near the front
      // of Google's error envelope, so it usually survives -- and it is the only
      // part worth showing.
      const m = /"message"\s*:\s*"([^"]*)"/.exec(e.body);
      if (m?.[1]) return m[1];
      if (e.body.length < 300 && !e.body.trimStart().startsWith("<")) return e.body;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Google Gemini, used for exactly one job: turning a release name that the
 * *arrs' own parsers could not resolve into a **search term**.
 *
 * The boundary is deliberate and load-bearing. Gemini never decides what a
 * download is, never picks between candidates, and never touches a file. It
 * proposes `{kind, title, year, season}`; that goes through the *arr's own
 * lookup, and a person confirms. A hallucination therefore costs a bad
 * suggestion — not the wrong film imported into the library under someone
 * else's name and renamed to match.
 *
 * It is also the *last* resort, not the first: `ArrAdapter.parse()` answers
 * most release names for free, deterministically, and with the same parser that
 * will perform the import. See `lib/identify.ts` for the ladder.
 */

/** What the model is asked to extract. Deliberately small and checkable. */
export interface ReleaseGuess {
  /** Which *arr should own this, or `unknown` when the model cannot tell. */
  kind: "movie" | "tv" | "music" | "unknown";
  /** The work's title, with scene punctuation and release tags stripped. */
  title: string;
  year?: number;
  /** TV only. */
  season?: number;
  /** The model's own confidence, 0–1, used only to sort and to warn. */
  confidence: number;
  /** One short sentence on why — shown to the user, never acted on. */
  reasoning?: string;
}

/**
 * An alias, deliberately, not a pinned version. A pinned default is wrong the
 * moment Google retires it -- `gemini-2.5-flash` was the obvious default when
 * this was written and is already refused for new keys ("no longer available to
 * new users"). An alias tracks whatever the current flash model is.
 */
const DEFAULT_MODEL = "gemini-flash-latest";
const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

/**
 * Gemini's free tier limits requests per minute, and a page of search results
 * can need many identifications at once. Firing them in parallel -- which is
 * what the batch route naturally does -- earns an immediate 429 for all of
 * them, so every call goes through this gate.
 *
 * Two at a time: enough that a page fills promptly, few enough that a free key
 * survives it.
 */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}
function release(): void {
  active--;
  waiting.shift()?.();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Google's own advice on when to come back, when it offers one. */
function retryDelayMs(e: unknown): number | null {
  if (!(e instanceof HttpError) || !e.body) return null;
  try {
    const details = (JSON.parse(e.body) as any)?.error?.details;
    for (const d of Array.isArray(details) ? details : []) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ""));
      const seconds = m?.[1] ? parseFloat(m[1]) : NaN;
      if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
    }
  } catch { /* not JSON; fall back to backoff */ }
  return null;
}

/**
 * Retry the transient refusals only. 429 (rate limited) and 503 (model
 * overloaded) both mean "ask again shortly" and both were hit on the very first
 * live run; everything else is a real fault and must surface immediately rather
 * than being retried into a longer wait for the same error.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 0;
      if (i >= attempts - 1 || (status !== 429 && status !== 503)) throw e;
      await sleep(retryDelayMs(e) ?? 1000 * 2 ** i);
    }
  }
}

/**
 * A response schema, so the model returns parseable JSON rather than prose with
 * a JSON block in it. `propertyOrdering` is not set: it affects only
 * presentation, and we read by key.
 */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    kind: { type: "STRING", enum: ["movie", "tv", "music", "unknown"] },
    title: { type: "STRING" },
    year: { type: "INTEGER" },
    season: { type: "INTEGER" },
    confidence: { type: "NUMBER" },
    reasoning: { type: "STRING" },
  },
  required: ["kind", "title", "confidence"],
} as const;

const SYSTEM_PROMPT = [
  "You identify what a torrent release name refers to.",
  "",
  "The input may be a scene-formatted release name, or simply a title as a person",
  "would write it, in any language. Both are normal. A name carrying no",
  "resolution, codec or release group is not thereby unidentifiable.",
  "",
  "Return ONLY the work's title as it would be catalogued, plus its year when the",
  "name gives one. Strip resolution, source, codec, audio, language tags, release",
  "group, and any bracketed site name. When a name carries a transliterated or",
  "translated title alongside an English one, prefer the English one.",
  "",
  "kind: 'movie' for films, 'tv' for series (set season when the name gives one),",
  "'music' for albums or discographies. Use 'unknown' ONLY when the thing is not a",
  "film, series or album at all — software, a game, a book — or when the name is",
  "too mangled to read. Do not answer 'unknown' merely because you are unsure",
  "which title it is: give your best title and a low confidence instead, because a",
  "low-confidence answer can still be checked against the library and a refusal",
  "cannot.",
  "",
  "confidence is your own 0-1 estimate that the title is right. Be honest and use",
  "low values freely; a low-confidence answer is useful and a confident wrong one",
  "is not. Never invent a year you cannot see or infer.",
].join("\n");

export class GeminiAdapter implements ServiceAdapter {
  readonly status = "functional" as const;
  readonly kind = "gemini";

  constructor(private cfg: AdapterConfig) {}

  private get baseUrl(): string {
    // The service row's baseUrl is optional here — Gemini is a public endpoint,
    // and an operator who leaves the field blank means "the normal one".
    return this.cfg.baseUrl?.trim() || DEFAULT_BASE;
  }

  get model(): string {
    const m = this.cfg.extra?.model;
    return typeof m === "string" && m.trim() ? m.trim() : DEFAULT_MODEL;
  }

  /** The key travels as a header, never in the query string — URLs get logged. */
  private hdr() { return { "x-goog-api-key": this.cfg.secret }; }

  /**
   * List the models this key can actually reach. This is the health check
   * because it costs no tokens and, more usefully, it is the only way to find
   * out that a configured model name is one this key cannot use — which
   * otherwise shows up as a failure on the first real request.
   */
  async models(timeoutMs = 15_000): Promise<string[]> {
    const res = await httpJson<{ models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }>(
      this.baseUrl, "/v1beta/models", { headers: this.hdr(), query: { pageSize: 200 }, timeoutMs },
    );
    return (res.models ?? [])
      // Only models that can answer a generateContent call are of any use here.
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      // Short: one dead provider must not hold the whole health response.
      const available = await this.models(8_000);
      const latencyMs = Date.now() - start;
      if (!available.length) {
        return { healthy: false, detail: "the key reached Google but can use no models", latencyMs };
      }
      // Name the mismatch rather than reporting a cheerful "healthy" that turns
      // into a 404 on the first identification.
      if (!available.includes(this.model)) {
        return {
          healthy: false,
          detail: `model "${this.model}" is not available to this key — try: ${available.slice(0, 3).join(", ")}`,
          latencyMs,
        };
      }
      // Listed is not the same as usable: a model can appear in ListModels and
      // still refuse a call ("no longer available to new users"), which is how
      // this check first reported Healthy while every identification 404'd.
      // The only proof that the configured model answers is to ask it.
      try {
        await this.generate("Probe.2020.1080p");
      } catch (e) {
        return {
          healthy: false,
          detail: `${this.model} is listed but will not answer: ${geminiMessage(e)}`,
          latencyMs: Date.now() - start,
        };
      }
      return {
        healthy: true, version: this.model,
        detail: `${available.length} models available; ${this.model} answered`,
        latencyMs: Date.now() - start,
      };
    } catch (e) {
      return { healthy: false, detail: geminiMessage(e), latencyMs: Date.now() - start };
    }
  }

  /**
   * Identify one release name. Returns null when the model declines or answers
   * something unusable — a null is a clean "no idea", which the caller can
   * report honestly, and is always preferable to a fabricated guess.
   */
  async identify(releaseName: string): Promise<ReleaseGuess | null> {
    await acquire();
    try {
      return await withRetry(() => this.generate(releaseName));
    } catch (e) {
      // Name the model: "not found for API version" is by far the most common
      // failure here, and it is unactionable without knowing what was asked for.
      throw new Error(`${this.model}: ${geminiMessage(e)}`);
    } finally {
      release();
    }
  }

  private async generate(releaseName: string): Promise<ReleaseGuess | null> {
    const res = await httpJson<any>(
      this.baseUrl, `/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: this.hdr(),
        timeoutMs: 30_000,
        body: {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: releaseName.slice(0, 512) }] }],
          generationConfig: {
            // Identification is not a creative task; the same name should give
            // the same answer twice.
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: 256,
          },
        },
      },
    );
    return parseGuess(res);
  }
}

/**
 * Find the model's JSON answer among the response parts.
 *
 * Reading `parts[0].text` is not enough. Gemini 3.x models emit **thinking**
 * parts alongside the answer, so slot 0 is routinely reasoning rather than the
 * result -- which parsed as nothing and turned a perfectly good identification
 * into a silent "could not identify". Every non-thought part is considered, and
 * a JSON object embedded in prose is recovered as a last resort.
 */
function extractJson(res: any): any {
  const parts = res?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;

  const texts: string[] = [];
  for (const p of parts) {
    if (p?.thought) continue; // reasoning, not the answer
    if (typeof p?.text === "string" && p.text.trim()) texts.push(p.text);
  }
  // Nothing but thoughts: fall back to every part, in case a build does not
  // flag them and the answer is in there somewhere.
  if (!texts.length) {
    for (const p of parts) {
      if (typeof p?.text === "string" && p.text.trim()) texts.push(p.text);
    }
  }

  for (const candidate of [...texts, texts.join("")]) {
    try {
      return JSON.parse(candidate);
    } catch { /* try the next shape */ }
    const brace = /\{[\s\S]*\}/.exec(candidate);
    if (brace) {
      try { return JSON.parse(brace[0]); } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Pull the guess out of a generateContent response and sanity-check it. The
 * response schema makes well-formed JSON very likely but not certain — safety
 * blocks, truncation and empty candidates all produce a valid response with no
 * usable content — so every field is re-validated here rather than trusted.
 */
export function parseGuess(res: any): ReleaseGuess | null {
  const raw = extractJson(res);
  if (!raw) return null;

  const title = typeof raw?.title === "string" ? raw.title.trim() : "";
  if (!title) return null; // a guess with no title identifies nothing

  const kind = ["movie", "tv", "music", "unknown"].includes(raw?.kind) ? raw.kind : "unknown";
  if (kind === "unknown") return null; // an honest refusal — treat it as one

  const year = Number.isInteger(raw?.year) && raw.year > 1870 && raw.year < 2200 ? raw.year : undefined;
  const season = Number.isInteger(raw?.season) && raw.season >= 0 && raw.season < 1000 ? raw.season : undefined;
  const confidence = typeof raw?.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence
    : 0.5; // an unusable confidence becomes "no opinion", never "certain"

  return {
    kind,
    title,
    year,
    season: kind === "tv" ? season : undefined,
    confidence,
    reasoning: typeof raw?.reasoning === "string" ? raw.reasoning.slice(0, 240) : undefined,
  };
}
