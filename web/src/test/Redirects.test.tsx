import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AppRoutes } from "../App.js";
import { resetCache } from "../lib/usePolled.js";
import { mockApi } from "./mockApi.js";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname}{l.search}</output>;
}

function renderAt(url: string, role: "admin" | "member") {
  mockApi({});
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AppRoutes role={role} onLogout={() => {}} />
      <Where />
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId("where").textContent;

beforeEach(() => resetCache());

describe("old URLs keep working", () => {
  it.each([
    ["/get", "/"],
    ["/get?q=dune", "/?q=dune"],
    ["/requests", "/activity?view=requests"],
    ["/downloads", "/transfers"],
    ["/queue", "/transfers"],
    ["/jobs", "/history"],
    ["/intake", "/imports"],
  ])("an admin at %s lands on %s", async (from, to) => {
    renderAt(from, "admin");
    await waitFor(() => expect(where()).toBe(to));
  });

  it("the new pages render under their own titles", async () => {
    for (const [url, title] of [["/transfers", "Transfers"], ["/history", "History"], ["/imports", "Imports to approve"]] as const) {
      const { unmount } = renderAt(url, "admin");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(title);
      unmount();
      resetCache();
    }
  });

  it("a member's old /requests bookmark opens Activity, without the admin tab", async () => {
    renderAt("/requests", "member");
    await waitFor(() => expect(where()).toBe("/activity"));
    expect(screen.queryByRole("button", { name: /^Requests/ })).toBeNull();
  });

  it.each(["/transfers", "/history", "/imports", "/downloads", "/queue", "/jobs", "/get"])("a member at %s ends up on Search", async (from) => {
    renderAt(from, "member");
    await waitFor(() => expect(where()).toBe("/"));
  });
});

describe("Search links to raw indexer search", () => {
  it("shows the hint under an admin's results, with the query carried over", async () => {
    mockApi({ "/api/hub/search": { results: [], sources: [] } });
    render(
      <MemoryRouter initialEntries={["/?q=dune"]}>
        <AppRoutes role="admin" onLogout={() => {}} />
        <Where />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: "Not finding it? Search indexers directly" });
    expect(link).toHaveAttribute("href", "/search?q=dune");
    expect(screen.getByTestId("raw-search-hint")).toHaveTextContent(/specific edition/);
    await userEvent.click(link);
    expect(where()).toBe("/search?q=dune");
  });

  it("never shows it to a member", async () => {
    mockApi({ "/api/hub/search": { results: [], sources: [] } });
    render(
      <MemoryRouter initialEntries={["/?q=dune"]}>
        <AppRoutes role="member" onLogout={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText("No matches");
    expect(screen.queryByTestId("raw-search-hint")).toBeNull();
  });
});
