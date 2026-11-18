import type { Buffer } from "node:buffer";
import { getServiceDecrypted } from "../config/store.js";
import { setServiceHealth } from "../config/store.js";
import { ArrAdapter } from "./arr.js";
import { QbittorrentAdapter } from "./qbittorrent.js";
import { ProwlarrAdapter } from "./prowlarr.js";
import { SlskdAdapter } from "./slskd.js";
import { JellyfinAdapter } from "./jellyfin.js";
import { NavidromeAdapter } from "./navidrome.js";
import { KavitaAdapter } from "./kavita.js";
import { AudiobookshelfAdapter } from "./audiobookshelf.js";
import { CalibreWebAdapter } from "./calibreweb.js";
import { TorrentSearchAdapter } from "./torrentsearch.js";
import { WebSearchAdapter } from "./websearch.js";
import { GeminiAdapter } from "./gemini.js";
import { TmdbAdapter } from "./tmdb.js";
import { RawgAdapter } from "./rawg.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

export type AnyAdapter =
  | ArrAdapter | QbittorrentAdapter | ProwlarrAdapter | SlskdAdapter
  | JellyfinAdapter | NavidromeAdapter | KavitaAdapter | AudiobookshelfAdapter | CalibreWebAdapter | TorrentSearchAdapter
  | WebSearchAdapter | GeminiAdapter | TmdbAdapter | RawgAdapter;

function build(kind: string, cfg: AdapterConfig): AnyAdapter {
  switch (kind) {
    case "radarr": return new ArrAdapter("radarr", cfg);
    case "sonarr": return new ArrAdapter("sonarr", cfg);
    case "lidarr": return new ArrAdapter("lidarr", cfg);
    case "qbittorrent": return new QbittorrentAdapter(cfg);
    case "prowlarr": return new ProwlarrAdapter(cfg);
    case "slskd": return new SlskdAdapter(cfg);
    case "jellyfin": return new JellyfinAdapter(cfg);
    case "navidrome": return new NavidromeAdapter(cfg);
    case "kavita": return new KavitaAdapter(cfg);
    case "audiobookshelf": return new AudiobookshelfAdapter(cfg);
    case "calibreweb": return new CalibreWebAdapter(cfg);
    case "torrentsearch": return new TorrentSearchAdapter(cfg);
    case "websearch": return new WebSearchAdapter(cfg);
    case "gemini": return new GeminiAdapter(cfg);
    case "tmdb": return new TmdbAdapter(cfg);
    case "rawg": return new RawgAdapter(cfg);
    default: throw new Error(`Unknown service kind: ${kind}`);
  }
}

/** Construct a configured adapter, or null if the service isn't set up. */
export function getAdapter(kind: string, masterKey: Buffer): AnyAdapter | null {
  const svc = getServiceDecrypted(kind, masterKey);
  if (!svc || !svc.enabled) return null;
  return build(kind, { baseUrl: svc.baseUrl, secret: svc.secret, extra: svc.extra });
}

/** Health-check one service using a *provided* config (used by the wizard's Test button). */
export async function testConfig(kind: string, cfg: AdapterConfig): Promise<HealthResult> {
  return (build(kind, cfg) as ServiceAdapter).health();
}

/** Health-check all configured services; persists last status. */
/** Coerce whatever an upstream called a "version" into something renderable. */
function versionString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const o = v as Record<string, unknown>;
  for (const field of ["current", "full", "version"]) {
    if (typeof o[field] === "string") return o[field] as string;
  }
  return undefined;
}

export async function checkAllHealth(kinds: string[], masterKey: Buffer): Promise<Record<string, HealthResult>> {
  const out: Record<string, HealthResult> = {};
  await Promise.all(kinds.map(async (kind) => {
    const a = getAdapter(kind, masterKey);
    if (!a) { out[kind] = { healthy: false, detail: "not configured" }; return; }
    const h = await (a as ServiceAdapter).health();
    // Adapters read `version` out of someone else's JSON, so its shape is not
    // ours to trust: slskd started returning an object and the dashboard, which
    // renders the value directly, threw and took the whole SPA down with it.
    // Normalising here means one place has to be right instead of nine.
    out[kind] = { ...h, version: versionString(h.version) };
    setServiceHealth(kind, h.healthy, h.detail ?? (h.healthy ? "ok" : "error"));
  }));
  return out;
}
