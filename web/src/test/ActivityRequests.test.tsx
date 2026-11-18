import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { Activity, type ActivityItem, type PendingRequest } from "../pages/Activity.js";
import { resetCache } from "../lib/usePolled.js";
import { mockApi } from "./mockApi.js";

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: "radarr:7", kind: "movie", title: "Dune", artwork: null, stage: "downloading", status: "active", progress: 40,
  etaSeconds: 600, startedAt: Date.now() - 60_000, requestedBy: "sam", source: "arr", ...over,
});
const req = (over: Partial<PendingRequest>): PendingRequest => ({
  id: "11111111-1111-4111-8111-111111111111", kind: "book", title: "Frankenstein", author: "Mary Shelley",
  requestedBy: "friend", createdAt: Date.now() - 3_600_000, ...over,
});

function renderActivity(role: "admin" | "member", url = "/activity") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/activity" element={<Activity role={role} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => resetCache());

describe("Activity: requests waiting for the admin", () => {
  it("an admin gets a Requests tab with the count, and can approve one", async () => {
    let pending = [req({}), req({ id: "22222222-2222-4222-8222-222222222222", kind: "audiobook", title: "Anthem", author: null })];
    const api = mockApi({
      "/api/activity": { items: [item({})], unavailable: [] },
      "/api/requests/pending": () => ({ items: pending }),
      "POST /api/requests/pending/11111111-1111-4111-8111-111111111111/approve": () => {
        pending = pending.slice(1);
        return { ok: true, release: "Frankenstein Mary Shelley epub" };
      },
    });
    renderActivity("admin");
    const tab = await screen.findByRole("button", { name: /Requests\s*2/ });
    await userEvent.click(tab);
    const list = await screen.findByRole("list", { name: "Requests waiting for you" });
    const row = within(list).getByText("Frankenstein").closest("li")!;
    expect(row).toHaveTextContent(/requested by friend/);
    await userEvent.click(within(row).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Approved: downloading "Frankenstein Mary Shelley epub"/)).toBeInTheDocument();
    expect(api.called("POST /api/requests/pending/11111111-1111-4111-8111-111111111111/approve")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText("Frankenstein")).toBeNull());
    expect(screen.getByText("Anthem")).toBeInTheDocument();
  });

  it("an admin can decline one, and an approve the server refuses says why", async () => {
    const api = mockApi({
      "/api/activity": { items: [], unavailable: [] },
      "/api/requests/pending": { items: [req({})] },
      "POST /api/requests/pending/11111111-1111-4111-8111-111111111111/approve": { status: 409, body: { error: "No book release matches the title and has seeders." } },
      "POST /api/requests/pending/11111111-1111-4111-8111-111111111111/decline": { ok: true },
    });
    renderActivity("admin", "/activity?view=requests");
    const list = await screen.findByRole("list", { name: "Requests waiting for you" });
    await userEvent.click(within(list).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/No book release matches/)).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Decline" }));
    expect(await screen.findByText("Declined.")).toBeInTheDocument();
    expect(api.called("POST /api/requests/pending/11111111-1111-4111-8111-111111111111/decline")).toHaveLength(1);
  });

  it("a member never sees the tab or asks for the pending list, even with ?view=requests", async () => {
    const api = mockApi({ "/api/activity": { items: [item({})], unavailable: [] }, "/api/requests/pending": { items: [req({})] } });
    renderActivity("member", "/activity?view=requests");
    await screen.findByText("Dune");
    expect(screen.queryByRole("button", { name: /^Requests/ })).toBeNull();
    expect(screen.queryByText("Frankenstein")).toBeNull();
    expect(api.called("GET /api/requests/pending")).toHaveLength(0);
  });

  it("?item= from Transfers highlights that row", async () => {
    mockApi({ "/api/activity": { items: [item({}), item({ id: "torrent:abc", title: "Other" })], unavailable: [] }, "/api/requests/pending": { items: [] } });
    renderActivity("admin", "/activity?item=torrent%3Aabc");
    const other = (await screen.findByText("Other")).closest("li")!;
    expect(other).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Dune").closest("li")).not.toHaveAttribute("aria-current");
  });
});
