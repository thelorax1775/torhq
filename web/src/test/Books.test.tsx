import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Books } from "../pages/Books.js";
import { mockApi } from "./mockApi.js";

const ready = {
  id: "w1", title: "Dune", author: "Frank Herbert", externalId: "OL1W", status: "ready", requestedBy: "friend",
  createdAt: Date.now(), updatedAt: Date.now(), releaseTitle: "Dune epub", releaseFormat: "epub",
  preview: {
    destPath: "/lib/books/Dune - Frank Herbert", sourcePath: "/dl/Dune", importMode: "move",
    entries: [{ name: "Dune.epub", size: 1000, isDir: false }], totalBytes: 1000, warnings: [], targetName: "Dune - Frank Herbert",
  },
};

function renderBooks(role: "admin" | "member", items: unknown[]) {
  const api = mockApi({
    "/api/books/wanted": { items },
    "/api/books/status": { ready: true, problems: [], category: "torhq-books" },
    "POST /api/books/wanted/w1/approve": { ok: true },
  });
  render(<MemoryRouter><Books role={role} /></MemoryRouter>);
  return api;
}

describe("Books page", () => {
  it("an admin approves a ready preview with one click, and the request is sent", async () => {
    const api = renderBooks("admin", [ready]);
    const btn = await screen.findByRole("button", { name: /approve import/i });
    expect(screen.getByText(/the download is moved, not copied/i)).toBeInTheDocument();
    await userEvent.click(btn);
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/api/books/wanted/w1/approve")).toBe(true));
  });

  it("a member sees their request's status but no approve button, paths or release controls", async () => {
    const { preview: _p, releaseTitle: _r, releaseFormat: _f, ...memberView } = ready;
    renderBooks("member", [memberView]);
    expect(await screen.findByText("Ready to import")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve import/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /find a release/i })).toBeNull();
    expect(screen.queryByText(/\/lib\/books/)).toBeNull();
    expect(screen.getByText("Your requests")).toBeInTheDocument();
  });
});

describe("Audiobooks page (the same page, kind=audiobook)", () => {
  it("talks to /api/audiobooks and uses audiobook wording and ranking", async () => {
    const api = mockApi({
      "/api/audiobooks/wanted": { items: [{ ...ready, id: "a1", releaseFormat: "m4b" }] },
      "/api/audiobooks/status": { ready: true, problems: [], category: "torhq-audiobooks" },
      "POST /api/audiobooks/wanted/a1/approve": { ok: true },
    });
    render(<MemoryRouter><Books role="admin" kind="audiobook" /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Audiobooks" })).toBeInTheDocument();
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByLabelText("Search audiobooks")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /approve import/i }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/api/audiobooks/wanted/a1/approve")).toBe(true));
    expect(api.calls.some((c) => c.path.startsWith("/api/books"))).toBe(false);
  });
});
