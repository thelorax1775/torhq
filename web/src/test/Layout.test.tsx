import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Layout, NAV } from "../components/Layout.js";
import { mockApi } from "./mockApi.js";

function renderLayout(role: "admin" | "member") {
  mockApi({});
  return render(
    <MemoryRouter initialEntries={["/requests"]}>
      <Routes>
        <Route element={<Layout onLogout={() => {}} role={role} />}>
          <Route path="/requests" element={<div>page body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const adminOnly = NAV.flatMap((g) => g.items).filter((i) => i.adminOnly).map((i) => i.label);
const shared = NAV.flatMap((g) => g.items).filter((i) => !i.adminOnly).map((i) => i.label);
const sidebar = () => within(screen.getByRole("complementary", { name: "Main" }));
const labels = (el: HTMLElement) => within(el).getAllByRole("link").map((a) => a.textContent?.trim());

describe("Layout navigation", () => {
  it("lists Search first, for everyone", () => {
    expect(NAV[0]!.items[0]).toMatchObject({ to: "/", label: "Search" });
    expect(NAV[0]!.items[0]!.adminOnly).toBeFalsy();
    // Retired from the nav; /dashboard, /books and /audiobooks still render for old bookmarks.
    expect(NAV.flatMap((g) => g.items).find((i) => i.label === "Dashboard")).toBeUndefined();
  });

  it("hides every admin-only link from a member", () => {
    renderLayout("member");
    expect(adminOnly.length).toBeGreaterThan(0);
    for (const label of adminOnly) expect(sidebar().queryByRole("link", { name: label })).toBeNull();
    for (const label of shared) expect(sidebar().getByRole("link", { name: label })).toBeInTheDocument();
    expect(screen.queryByText("System")).toBeNull();
  });

  it("shows admin-only links to an admin", () => {
    renderLayout("admin");
    for (const label of adminOnly) expect(sidebar().getByRole("link", { name: label })).toBeInTheDocument();
  });

  it("gives a member exactly Search, Discover, Activity", () => {
    renderLayout("member");
    expect(shared).toEqual(["Search", "Discover", "Activity"]);
    expect(labels(screen.getByRole("complementary", { name: "Main" }))).toEqual(["TorHQ", "Search", "Discover", "Activity"]);
  });

  it("gives an admin the three, then Library and System in order, with no Advanced group", () => {
    renderLayout("admin");
    const side = screen.getByRole("complementary", { name: "Main" });
    expect(labels(side)).toEqual([
      "TorHQ", "Search", "Discover", "Activity",
      "Imports to approve", "Libraries",
      "Transfers", "History", "Services", "Mounts", "Settings", "Users",
    ]);
    expect(Array.from(side.querySelectorAll(".nav-group-label")).map((e) => e.textContent)).toEqual(["Library", "System"]);
    expect(screen.queryByText("Advanced")).toBeNull();
    // Raw search is reached from the bottom of Search results, not the nav.
    expect(NAV.flatMap((g) => g.items).find((i) => i.to === "/search")).toBeUndefined();
  });

  it("badges Activity and Imports to approve with what waits for an admin", async () => {
    mockApi({ "/api/attention": { requests: 2, imports: 1 } });
    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <Routes>
          <Route element={<Layout onLogout={() => {}} role="admin" />}>
            <Route path="/requests" element={<div>page body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const activity = await sidebar().findByRole("link", { name: /Activity/ });
    await within(activity).findByText("2");
    expect(within(sidebar().getByRole("link", { name: /Imports to approve/ })).getByText("1")).toBeInTheDocument();
    // The phone tab bar carries the Activity badge too.
    expect(within(screen.getByRole("navigation", { name: "Primary" }).querySelector('a[href="/activity"]') as HTMLElement).getByText("2")).toBeInTheDocument();
  });

  it("never asks a member's browser for the admin counts", () => {
    const api = mockApi({ "/api/attention": { requests: 2, imports: 1 } });
    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <Routes>
          <Route element={<Layout onLogout={() => {}} role="member" />}>
            <Route path="/requests" element={<div>page body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(api.called("GET /api/attention")).toHaveLength(0);
  });

  it("puts the primary pages in the phone tab bar", () => {
    renderLayout("member");
    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(labels(bar)).toEqual(["Search", "Discover", "Activity"]);
    expect(within(bar).getByRole("button", { name: "More" })).toBeInTheDocument();
  });

  it("still renders for a member when /api/downloads is the reduced response", async () => {
    mockApi({ "/api/downloads": { torrents: [], categories: {}, transfer: { dlspeed: 2048, upspeed: 1024 } } });
    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <Routes>
          <Route element={<Layout onLogout={() => {}} role="member" />}>
            <Route path="/requests" element={<div>page body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(await screen.findByTitle("qBittorrent transfer rates")).toBeInTheDocument();
  });
});
