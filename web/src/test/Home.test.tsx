import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Home } from "../pages/Home.js";
import { mockApi } from "./mockApi.js";

const dune = { kind: "movie", id: "tmdb:1", title: "Dune: Part Two", year: 2024, status: "none", owner: "radarr", actionable: true };
const held = { kind: "movie", id: "tmdb:2", title: "Endgame", year: 2019, status: "available", owner: "radarr", actionable: false };
const book = { kind: "book", id: "OL1W", title: "Dune", year: 1965, subtitle: "Frank Herbert", status: "unknown", owner: "intake", actionable: false };

function routes(over: Record<string, unknown> = {}) {
  return {
    "/api/hub/search": { results: [dune, held, book], sources: [
      { kind: "movie", available: true }, { kind: "book", available: true },
    ] },
    "/api/hub/item": () => ({ item: { ...dune, genres: ["Sci-Fi"], addOptions: { service: "radarr", qualityProfileId: 4, rootFolderPath: "/movies", basis: "saved" } } }),
    "/api/requests/movie/options": { profiles: [{ id: 4, name: "HD" }], roots: [], metadataProfiles: [] },
    "/api/acquire/defaults": { services: [{ service: "radarr", configured: true, profiles: [{ id: 4, name: "HD" }], roots: [{ id: 1, path: "/movies" }], metadataProfiles: [] }] },
    ...over,
  };
}

function renderHome(role: "admin" | "member", url = "/?q=dune") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<Home role={role} />} />
        <Route path="/get" element={<div>get page</div>} />
        <Route path="/books" element={<div>books page</div>} />
        <Route path="/audiobooks" element={<div>audiobooks page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Home search hub", () => {
  it("renders results from the API with kind and status", async () => {
    const api = mockApi(routes());
    renderHome("admin");
    const grid = await screen.findByRole("list", { name: "Results" });
    expect(within(grid).getByText("Dune: Part Two")).toBeInTheDocument();
    expect(within(grid).getByText("Available")).toBeInTheDocument();
    expect(within(grid).getByText(/2024 · Movie/)).toBeInTheDocument();
    expect(api.called("GET /api/hub/search")[0]!.path).toBe("/api/hub/search");
  });

  it("a member sees Request, never Add", async () => {
    mockApi(routes());
    renderHome("member");
    await userEvent.click(await screen.findByRole("button", { name: /Dune: Part Two/ }));
    expect(await screen.findByRole("button", { name: "Request" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("an admin sees Add, and Options reveals Choose release", async () => {
    mockApi(routes());
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Dune: Part Two/ }));
    expect(await screen.findByRole("button", { name: "Add" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(await screen.findByRole("link", { name: /Choose release/ })).toBeInTheDocument();
    expect(await screen.findByLabelText("Root folder")).toHaveValue("/movies");
  });

  it("members never see Choose release or a root folder", async () => {
    mockApi(routes());
    renderHome("member");
    await userEvent.click(await screen.findByRole("button", { name: /Dune: Part Two/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Options" }));
    await screen.findByLabelText("Quality profile");
    expect(screen.queryByRole("link", { name: /Choose release/ })).toBeNull();
    expect(screen.queryByLabelText("Root folder")).toBeNull();
  });

  it("an available item's button is disabled and says why", async () => {
    mockApi(routes({ "/api/hub/item": { item: { ...held, genres: [] } } }));
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Endgame/ }));
    expect(await screen.findByRole("button", { name: "Already available" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("an audiobook without Prowlarr/qBittorrent explains its backend isn't set up instead of a dead button", async () => {
    const audio = { ...book, kind: "audiobook", id: "OL2W", actionable: false };
    mockApi(routes({ "/api/hub/search": { results: [audio], sources: [{ kind: "audiobook", available: true }] }, "/api/hub/item": { item: { ...audio, genres: [] } } }));
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Dune \(1965\), Audiobook/ }));
    expect(await screen.findByText(/isn't set up yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add unavailable" })).toBeDisabled();
  });

  it("an actionable audiobook is requested through /api/audiobooks/request and an admin lands on the audiobooks page", async () => {
    const audio = { ...book, kind: "audiobook", id: "OL2W", actionable: true };
    const api = mockApi(routes({
      "/api/hub/search": { results: [audio], sources: [{ kind: "audiobook", available: true }] },
      "/api/hub/item": { item: { ...audio, genres: [] } },
      "POST /api/audiobooks/request": { ok: true, existing: false },
    }));
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Dune \(1965\), Audiobook/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.called("POST /api/audiobooks/request")).toHaveLength(1));
    expect(api.called("POST /api/books/request")).toHaveLength(0);
    expect(api.called("POST /api/audiobooks/request")[0]!.body).toMatchObject({ title: "Dune", externalId: "OL2W" });
    expect(await screen.findByText("audiobooks page")).toBeInTheDocument();
  });

  it("a downloaded audiobook offers Approve import to an admin in the hub, via the audiobooks API", async () => {
    const audio = { ...book, kind: "audiobook", id: "OL2W", actionable: false, status: "downloading" };
    const api = mockApi(routes({
      "/api/hub/search": { results: [audio], sources: [{ kind: "audiobook", available: true }] },
      "/api/hub/item": { item: { ...audio, genres: [] } },
      "/api/audiobooks/wanted": { items: [{ id: "w7", externalId: "OL2W", status: "ready" }] },
      "POST /api/audiobooks/wanted/w7/approve": { ok: true },
    }));
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Dune \(1965\), Audiobook/ }));
    await userEvent.click(await screen.findByRole("button", { name: /approve import/i }));
    await waitFor(() => expect(api.called("POST /api/audiobooks/wanted/w7/approve")).toHaveLength(1));
  });

  it("an actionable book is requested through /api/books/request; a member sees Request", async () => {
    const live = { ...book, actionable: true };
    const api = mockApi(routes({
      "/api/hub/search": { results: [live], sources: [{ kind: "book", available: true }] },
      "/api/hub/item": { item: { ...live, genres: [] } },
      "POST /api/books/request": { ok: true, existing: false },
    }));
    renderHome("member");
    await userEvent.click(await screen.findByRole("button", { name: /Dune \(1965\), Book/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Request" }));
    await waitFor(() => expect(api.called("POST /api/books/request")).toHaveLength(1));
    expect(api.called("POST /api/books/request")[0]!.body).toMatchObject({ title: "Dune", author: "Frank Herbert", externalId: "OL1W" });
  });

  it("an admin adding a book requests it, then lands on the release picker", async () => {
    const live = { ...book, actionable: true };
    const api = mockApi(routes({
      "/api/hub/search": { results: [live], sources: [{ kind: "book", available: true }] },
      "/api/hub/item": { item: { ...live, genres: [] } },
      "POST /api/books/request": { ok: true, existing: false },
    }));
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Dune \(1965\), Book/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.called("POST /api/books/request")).toHaveLength(1));
    expect(await screen.findByText("books page")).toBeInTheDocument();
  });

  it("a downloaded book offers Approve import to an admin right in the hub", async () => {
    const dl = { ...book, actionable: false, status: "downloading" };
    const api = mockApi(routes({
      "/api/hub/search": { results: [dl], sources: [{ kind: "book", available: true }] },
      "/api/hub/item": { item: { ...dl, genres: [] } },
      "/api/books/wanted": { items: [{ id: "w9", externalId: "OL1W", status: "ready" }] },
      "POST /api/books/wanted/w9/approve": { ok: true },
    }));
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Dune \(1965\), Book/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve import" }));
    await waitFor(() => expect(api.called("POST /api/books/wanted/w9/approve")).toHaveLength(1));
  });

  it("shows a degraded source's reason", async () => {
    mockApi(routes({ "/api/hub/search": { results: [dune], sources: [
      { kind: "movie", available: true }, { kind: "music", available: false, detail: "Lidarr is not configured. Add it under Services." },
    ] } }));
    renderHome("member");
    expect(await screen.findByText("Lidarr is not configured. Add it under Services.")).toBeInTheDocument();
  });

  it("admin Add prepares in the *arr, asks it to search, then flips the badge and toasts a link", async () => {
    const api = mockApi(routes({
      "POST /api/acquire/prepare": { ok: true, id: 77, service: "radarr" },
      "POST /api/acquire/auto-search": { ok: true },
    }));
    renderHome("admin");
    await userEvent.click(await screen.findByRole("button", { name: /Dune: Part Two/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.called("POST /api/acquire/auto-search")).toHaveLength(1));
    expect(api.called("POST /api/acquire/prepare")[0]!.body).toMatchObject({ service: "radarr", selectionId: "tmdb:1", term: "tmdb:1" });
    expect(api.called("POST /api/acquire/auto-search")[0]!.body).toEqual({ service: "radarr", id: 77 });
    expect(await screen.findByRole("link", { name: /Queue/ })).toHaveAttribute("href", "/queue");
    const card = screen.getByRole("button", { name: /Dune: Part Two/ });
    expect(within(card).getByText("Requested")).toBeInTheDocument();
  });

  it("member Request goes through /api/requests", async () => {
    const api = mockApi(routes({ "POST /api/requests/movie": { ok: true, id: 1, title: "Dune" } }));
    renderHome("member");
    await userEvent.click(await screen.findByRole("button", { name: /Dune: Part Two/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Request" }));
    await waitFor(() => expect(api.called("POST /api/requests/movie")).toHaveLength(1));
    expect(api.called("POST /api/acquire/prepare")).toHaveLength(0);
    expect(api.called("POST /api/requests/movie")[0]!.body).toMatchObject({ selectionId: "tmdb:1" });
  });

  it("debounces typing into the URL-backed query", async () => {
    const api = mockApi(routes());
    renderHome("admin", "/");
    await userEvent.type(screen.getByRole("searchbox"), "dune");
    await screen.findByRole("list", { name: "Results" });
    expect(api.called("GET /api/hub/search").length).toBe(1);
  });
});
