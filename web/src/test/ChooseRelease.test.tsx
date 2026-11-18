import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { Home } from "../pages/Home.js";
import { resetCache } from "../lib/usePolled.js";
import { mockApi, type MockRequest } from "./mockApi.js";

// The hub sheet's Options > Choose release, end to end against a mocked API:
// add to the *arr without a search, pick a season/album where there is one,
// run the *arr's interactive search, grab the chosen release through the *arr.

const SEARCH_ID = "0b6c6a3e-1111-4111-8111-111111111111";
const release = (over: Record<string, unknown>) => ({
  guid: "g1", indexerId: 4, indexer: "Idx", title: "Release.One.1080p", size: 4_000_000_000,
  seeders: 30, leechers: 1, protocol: "torrent", quality: "Bluray-1080p", rejected: false, rejections: [], ...over,
});

const CASES = {
  movie: {
    result: { kind: "movie", id: "tmdb:1", title: "Dune: Part Two", year: 2024, status: "none", owner: "radarr", actionable: true },
    service: "radarr", preparedId: 77,
  },
  tv: {
    result: { kind: "tv", id: "tvdb:9", title: "Severance", year: 2022, status: "missing", owner: "sonarr", actionable: true },
    service: "sonarr", preparedId: 88,
  },
  music: {
    result: { kind: "music", id: "mbid:abc-123", title: "Radiohead", status: "none", owner: "lidarr", actionable: true },
    service: "lidarr", preparedId: 99,
  },
} as const;

function routes(c: (typeof CASES)[keyof typeof CASES], polls: { n: number }) {
  return {
    "/api/hub/search": { results: [c.result], sources: [{ kind: c.result.kind, available: true }] },
    "/api/hub/item": { item: { ...c.result, genres: [], addOptions: { service: c.service, qualityProfileId: 4, rootFolderPath: "/media", basis: "saved" } } },
    "/api/acquire/defaults": { services: [{ service: c.service, configured: true, profiles: [{ id: 4, name: "HD" }], roots: [{ id: 1, path: "/media" }], metadataProfiles: [{ id: 2, name: "Standard" }] }] },
    "POST /api/acquire/prepare": (r: MockRequest) => ({ ok: true, id: c.preparedId, title: c.result.title, service: (r.body as { service: string }).service, rootFolderPath: "/media", qualityProfileId: 4 }),
    "/api/acquire/targets": c.service === "sonarr"
      ? { kind: "season", seasons: [{ seasonNumber: 1, monitored: true, episodeFileCount: 9, totalEpisodeCount: 9 }, { seasonNumber: 2, monitored: true, episodeFileCount: 0, totalEpisodeCount: 10 }] }
      : { kind: "album", albums: [{ id: 501, title: "OK Computer", year: 1997 }, { id: 502, title: "Kid A", year: 2000 }] },
    "POST /api/acquire/search": { ok: true, id: SEARCH_ID, service: c.service, label: c.result.title, status: "running", elapsedMs: 0, releases: null, error: null },
    [`/api/acquire/search/${SEARCH_ID}`]: () => {
      polls.n += 1;
      return {
        id: SEARCH_ID, service: c.service, label: c.result.title, status: "done", elapsedMs: 1200, error: null,
        releases: [release({}), release({ guid: "g2", title: "Release.Two.2160p", rejected: true, rejections: ["Not wanted in profile"] })],
      };
    },
    "POST /api/acquire/grab": { ok: true, service: c.service },
  };
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/?q=x"]}>
      <Routes><Route path="/" element={<Home role="admin" />} /></Routes>
    </MemoryRouter>,
  );
}

async function openChooser(title: string) {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(title) }));
  await userEvent.click(await screen.findByRole("button", { name: "Options" }));
  await userEvent.click(await screen.findByRole("button", { name: /Choose release/ }));
  return screen.findByLabelText("Choose release");
}

async function grabFirst(api: ReturnType<typeof mockApi>, service: string) {
  const list = await screen.findByRole("list", { name: "Releases" });
  // Refused releases stay hidden until asked for.
  expect(within(list).queryByText("Release.Two.2160p")).toBeNull();
  await userEvent.click(within(list).getByRole("button", { name: "Grab Release.One.1080p" }));
  await waitFor(() => expect(api.called("POST /api/acquire/grab")).toHaveLength(1));
  expect(api.called("POST /api/acquire/grab")[0]!.body).toEqual({ service, guid: "g1", indexerId: 4, title: "Release.One.1080p", override: false });
  // The sheet closes with a toast that points at Activity.
  expect(await screen.findByRole("status")).toHaveTextContent(/is downloading "Release.One.1080p"/);
}

beforeEach(() => resetCache());

describe("Choose release from the hub sheet", () => {
  it("movie: adds to Radarr without a search, searches straight away, grabs the pick", async () => {
    const c = CASES.movie;
    const api = mockApi(routes(c, { n: 0 }));
    renderHome();
    await openChooser(c.result.title);
    await waitFor(() => expect(api.called("POST /api/acquire/prepare")).toHaveLength(1));
    expect(api.called("POST /api/acquire/prepare")[0]!.body).toMatchObject({ service: "radarr", term: "tmdb:1", selectionId: "tmdb:1" });
    await waitFor(() => expect(api.called("POST /api/acquire/search")).toHaveLength(1));
    expect(api.called("POST /api/acquire/search")[0]!.body).toMatchObject({ service: "radarr", id: 77 });
    expect(api.called("GET /api/acquire/targets")).toHaveLength(0);
    await grabFirst(api, "radarr");
  });

  it("TV: asks for a season first and searches only that season", async () => {
    const c = CASES.tv;
    const api = mockApi(routes(c, { n: 0 }));
    renderHome();
    const panel = await openChooser(c.result.title);
    const find = await within(panel).findByRole("button", { name: "Find releases" });
    expect(find).toBeDisabled(); // Sonarr searches one season at a time
    await userEvent.selectOptions(within(panel).getByLabelText("Season"), "2");
    await userEvent.click(find);
    await waitFor(() => expect(api.called("POST /api/acquire/search")).toHaveLength(1));
    expect(api.called("POST /api/acquire/search")[0]!.body).toMatchObject({ service: "sonarr", id: 88, seasonNumber: 2 });
    await grabFirst(api, "sonarr");
  });

  it("album: lets the admin pick one album of the artist", async () => {
    const c = CASES.music;
    const api = mockApi(routes(c, { n: 0 }));
    renderHome();
    const panel = await openChooser(c.result.title);
    expect(api.called("POST /api/acquire/prepare").length).toBeLessThanOrEqual(1);
    await waitFor(() => expect(api.called("POST /api/acquire/prepare")[0]!.body).toMatchObject({ service: "lidarr", term: "lidarr:abc-123", selectionId: "mbid:abc-123" }));
    await userEvent.selectOptions(await within(panel).findByLabelText("Album"), "501");
    await userEvent.click(within(panel).getByRole("button", { name: "Find releases" }));
    await waitFor(() => expect(api.called("POST /api/acquire/search")).toHaveLength(1));
    expect(api.called("POST /api/acquire/search")[0]!.body).toMatchObject({ service: "lidarr", id: 99, albumId: 501 });
    await grabFirst(api, "lidarr");
  });

  it("a refused release can still be grabbed on purpose, marked as an override", async () => {
    const c = CASES.movie;
    const api = mockApi(routes(c, { n: 0 }));
    renderHome();
    const panel = await openChooser(c.result.title);
    await within(panel).findByRole("list", { name: "Releases" });
    await userEvent.click(within(panel).getByLabelText("Show refused"));
    await userEvent.click(within(panel).getByRole("button", { name: "Grab Release.Two.2160p" }));
    await waitFor(() => expect(api.called("POST /api/acquire/grab")).toHaveLength(1));
    expect(api.called("POST /api/acquire/grab")[0]!.body).toMatchObject({ guid: "g2", override: true });
  });
});
