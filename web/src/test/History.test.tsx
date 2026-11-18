import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { History } from "../pages/History.js";
import { mockApi } from "./mockApi.js";

describe("History", () => {
  it("a book's 'ready for approval' entry links to Imports to approve", async () => {
    mockApi({
      "/api/jobs": { jobs: [] },
      "/api/activity/log": { activity: [
        { id: 1, jobId: null, kind: "completed", service: "books", message: 'Downloaded "Dune". Import preview ready for approval (1 entries).', createdAt: Date.now() },
        { id: 2, jobId: null, kind: "info", service: "books", message: "Book request declined (admin)", createdAt: Date.now() },
      ] },
    });
    render(<MemoryRouter><History /></MemoryRouter>);
    const links = await screen.findAllByRole("link", { name: /approve import/i });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/imports");
  });
});
