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

  it("gives an admin the three, then Library, Advanced and System in order", () => {
    renderLayout("admin");
    const side = screen.getByRole("complementary", { name: "Main" });
    expect(labels(side)).toEqual([
      "TorHQ", "Search", "Discover", "Activity",
      "Intake", "Libraries",
      "Get", "Raw search", "Downloads", "Queue", "Jobs & log", "Requests",
      "Services", "Mounts", "Settings", "Users",
    ]);
    expect(Array.from(side.querySelectorAll(".nav-group-label")).map((e) => e.textContent)).toEqual(["Library", "Advanced", "System"]);
  });

  it("puts the primary pages in the phone tab bar", () => {
    renderLayout("member");
    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(labels(bar)).toEqual(["Search", "Discover", "Activity"]);
    expect(within(bar).getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});
