import { httpJson } from "./http.js";

/**
 * Open Library — metadata for books and audiobooks (no key, public API).
 * It only describes titles; nothing here downloads or files anything.
 */
export const OPENLIBRARY_BASE = "https://openlibrary.org";

export interface OpenLibraryWork {
  /** The work id, e.g. `OL45804W`. */
  id: string;
  title: string;
  year?: number;
  author?: string;
  poster?: string;
  overview?: string;
}

function work(raw: any): OpenLibraryWork | null {
  const key = typeof raw?.key === "string" ? raw.key.replace(/^\/works\//, "") : "";
  if (!/^OL\d+W$/.test(key) || typeof raw?.title !== "string" || !raw.title) return null;
  const authors: string[] = Array.isArray(raw.author_name) ? raw.author_name.filter((a: unknown) => typeof a === "string") : [];
  const first = Array.isArray(raw.first_sentence) ? raw.first_sentence[0] : raw.first_sentence;
  return {
    id: key,
    title: raw.title,
    year: Number.isInteger(raw.first_publish_year) ? raw.first_publish_year : undefined,
    author: authors.slice(0, 2).join(", ") || undefined,
    poster: Number.isInteger(raw.cover_i) ? `https://covers.openlibrary.org/b/id/${raw.cover_i}-M.jpg` : undefined,
    overview: typeof first === "string" && first ? first.slice(0, 400) : undefined,
  };
}

const UA = { "user-agent": "TorHQ (self-hosted media hub)" };

export async function searchOpenLibrary(q: string, limit = 10, timeoutMs = 8000): Promise<OpenLibraryWork[]> {
  const res = await httpJson<{ docs?: any[] }>(OPENLIBRARY_BASE, "search.json", {
    headers: UA, timeoutMs,
    query: { q, limit, fields: "key,title,author_name,first_publish_year,cover_i,first_sentence" },
  });
  return (res?.docs ?? []).map(work).filter((w): w is OpenLibraryWork => w !== null);
}

export async function openLibraryWork(id: string, timeoutMs = 8000): Promise<OpenLibraryWork | null> {
  if (!/^OL\d+W$/.test(id)) return null;
  const w = await httpJson<any>(OPENLIBRARY_BASE, `works/${id}.json`, { headers: UA, timeoutMs });
  if (!w?.title) return null;
  const desc = typeof w.description === "string" ? w.description : w.description?.value;
  const cover = Array.isArray(w.covers) ? w.covers.find((c: unknown) => Number.isInteger(c) && (c as number) > 0) : undefined;
  return {
    id, title: w.title,
    year: typeof w.first_publish_date === "string" ? Number(w.first_publish_date.match(/\d{4}/)?.[0]) || undefined : undefined,
    poster: cover ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg` : undefined,
    overview: typeof desc === "string" && desc ? desc.slice(0, 1200) : undefined,
  };
}
