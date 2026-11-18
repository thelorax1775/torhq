/**
 * Fake `fetch` for component tests. Routes are keyed "METHOD /api/path"
 * (a bare "/api/path" means GET); a value is either a JSON body, a
 * `{ status, body }` pair, or a function of the request. Unmatched /api calls
 * answer 404 and are recorded, so a test can assert what the UI asked for.
 */
import { vi } from "vitest";

export interface MockRequest { method: string; path: string; body: unknown; headers: Record<string, string> }
export type MockReply = { status?: number; body?: unknown };
export type MockRoute = unknown | MockReply | ((req: MockRequest) => unknown | MockReply);
export type MockRoutes = Record<string, MockRoute>;

function isReply(v: unknown): v is MockReply {
  return typeof v === "object" && v !== null && ("status" in v) && Object.keys(v).every((k) => k === "status" || k === "body");
}

export function mockApi(routes: MockRoutes) {
  const calls: MockRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    let body: unknown = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep raw */ } }
    const req: MockRequest = {
      method, path: url.pathname, body,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
    };
    calls.push(req);
    const key = `${method} ${url.pathname}`;
    const route = key in routes ? routes[key] : method === "GET" ? routes[url.pathname] : undefined;
    let out: unknown = route === undefined ? { status: 404, body: { error: "not mocked" } } : route;
    if (typeof out === "function") out = await (out as (r: MockRequest) => unknown)(req);
    const reply: MockReply = isReply(out) ? out : { status: 200, body: out };
    const status = reply.status ?? 200;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status, headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetch: fetchMock, called: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}
