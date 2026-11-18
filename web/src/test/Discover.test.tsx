import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Redirect } from "../App.js";
import { Discover } from "../pages/Discover.js";
import { mockApi } from "./mockApi.js";

const movie = { kind: "movie", id: "603", title: "The Matrix", year: 1999, genres: ["Sci-Fi"], selectionId: "tmdb:603" };
const routes = () => ({
  "/api/catalogue/sources": { kinds: { movie: { available: true, source: "TMDB", lists: ["trending"] }, tv: { available: true, source: "TMDB", lists: ["trending"] }, game: { available: false, source: "RAWG", lists: [] } }, platforms: [] },
  "/api/catalogue/genres": { genres: [] },
  "/api/catalogue/browse": { kind: "movie", items: [movie], page: 1, totalPages: 1, libraryChecked: true },
  "/api/hub/item": { item: { kind: "movie", id: "tmdb:603", title: "The Matrix", status: "none", owner: "radarr", actionable: true, genres: [], addOptions: { service: "radarr", basis: "saved" } } },
  "POST /api/requests/movie": { ok: true },
  "POST /api/acquire/prepare": { id: 7, service: "radarr" },
  "POST /api/acquire/auto-search": { ok: true },
});

function renderDiscover(role: "admin" | "member") {
  return render(
    <MemoryRouter initialEntries={["/discover"]}>
      <Routes><Route path="/discover" element={<Discover role={role} />} /></Routes>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const l = useLocation();
  return <div>at {l.pathname}{l.search}</div>;
}

describe("Discover", () => {
  it("opens the hub's detail sheet with the single Request action for a member", async () => {
    const api = mockApi(routes());
    renderDiscover("member");
    await userEvent.click(await screen.findByRole("button", { name: /The Matrix/ }));
    const request = await screen.findByRole("button", { name: "Request" });
    expect(screen.queryByRole("link", { name: /Get|Find releases/ })).toBeNull();
    await userEvent.click(request);
    expect(await screen.findByText(/Requested "The Matrix"/)).toBeInTheDocument();
    expect(api.called("POST /api/requests/movie")[0]!.body).toMatchObject({ selectionId: "tmdb:603", searchNow: true });
  });

  it("shows Add for an admin and adds through the hub flow", async () => {
    const api = mockApi(routes());
    renderDiscover("admin");
    await userEvent.click(await screen.findByRole("button", { name: /The Matrix/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByText(/Added "The Matrix"/)).toBeInTheDocument();
    expect(api.called("POST /api/acquire/auto-search")).toHaveLength(1);
  });

  it("keeps the old /catalogue bookmark working by redirecting to /discover", () => {
    mockApi(routes());
    render(
      <MemoryRouter initialEntries={["/catalogue?kind=movie"]}>
        <Routes>
          <Route path="/catalogue" element={<Redirect to="/discover" />} />
          <Route path="/discover" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("at /discover?kind=movie")).toBeInTheDocument();
  });
});
