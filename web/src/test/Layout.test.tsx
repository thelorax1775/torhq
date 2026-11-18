import { render, screen } from "@testing-library/react";
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

describe("Layout navigation", () => {
  it("lists Search first, for everyone", () => {
    expect(NAV[0]!.items[0]).toMatchObject({ to: "/", label: "Search" });
    expect(NAV[0]!.items[0]!.adminOnly).toBeFalsy();
    expect(NAV.flatMap((g) => g.items).find((i) => i.label === "Dashboard")).toMatchObject({ to: "/dashboard", adminOnly: true });
  });

  it("hides every admin-only link from a member", () => {
    renderLayout("member");
    expect(adminOnly.length).toBeGreaterThan(0);
    for (const label of adminOnly) expect(screen.queryByRole("link", { name: label })).toBeNull();
    for (const label of shared) expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    expect(screen.queryByText("System")).toBeNull();
  });

  it("shows admin-only links to an admin", () => {
    renderLayout("admin");
    for (const label of adminOnly) expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  });
});
