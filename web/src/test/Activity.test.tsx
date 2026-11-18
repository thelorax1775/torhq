import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { Activity, STAGES, type ActivityItem } from "../pages/Activity.js";
import { resetCache } from "../lib/usePolled.js";
import { Layout, NAV } from "../components/Layout.js";
import { mockApi } from "./mockApi.js";

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: "x", kind: "movie", title: "Dune", artwork: null, stage: "downloading", status: "active", progress: 40,
  etaSeconds: 600, startedAt: Date.now() - 60_000, requestedBy: "sam", source: "arr", ...over,
});
const feed = (items: ActivityItem[], unavailable: unknown[] = []) => ({ "/api/activity": { items, unavailable } });

function renderActivity(role: "admin" | "member") {
  return render(
    <MemoryRouter initialEntries={["/activity"]}>
      <Routes>
        <Route path="/activity" element={<Activity role={role} />} />
        <Route path="/transfers" element={<div>transfers page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => resetCache());

describe("Activity page", () => {
  it.each(STAGES.map((s, i) => [s, i] as const))("renders the stepper for the %s stage", async (stage, idx) => {
    const done = stage === "available";
    mockApi(feed([item({ stage, status: done ? "done" : "active", progress: done ? 100 : 40, etaSeconds: null })]));
    renderActivity("member");
    const row = (await screen.findAllByRole("listitem")).find((li) => li.getAttribute("data-stage") === stage)!;
    const steps = within(row).getByRole("list", { name: new RegExp(`Stage: ${stage}`, "i") }).querySelectorAll("li");
    expect(steps).toHaveLength(5);
    const states = [...steps].map((s) => s.getAttribute("data-state"));
    expect(states.slice(0, idx).every((s) => s === "done")).toBe(true);
    expect(states[idx]).toBe(done ? "done" : "current");
    expect(states.slice(idx + 1).every((s) => s === "todo")).toBe(true);
  });

  it("shows a progress bar with percent and ETA while downloading, none while searching", async () => {
    mockApi(feed([item({ id: "a" }), item({ id: "b", title: "Severance", stage: "searching", progress: 0, etaSeconds: null })]));
    renderActivity("member");
    const dune = (await screen.findByText("Dune")).closest("li")!;
    expect(within(dune).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(within(dune).getByText(/40% · 10m 0s left/)).toBeInTheDocument();
    expect(within(screen.getByText("Severance").closest("li")!).queryByRole("progressbar")).toBeNull();
  });

  it("a stall shows the reason and the fix in plain words", async () => {
    mockApi(feed([item({ stage: "importing", status: "stalled", progress: 100, etaSeconds: null,
      stall: { reason: "Radarr cannot see the download folder.", fix: "Mount it into Radarr." } })]));
    renderActivity("member");
    expect(await screen.findByText(/Radarr cannot see the download folder/)).toBeInTheDocument();
    expect(screen.getByText(/Mount it into Radarr/)).toBeInTheDocument();
    expect(screen.getByText("Stalled · Importing")).toBeInTheDocument();
  });

  it("filters in progress / stalled / done", async () => {
    mockApi(feed([
      item({ id: "1", title: "Active One" }),
      item({ id: "2", title: "Stuck One", status: "stalled", stall: { reason: "r", fix: "f" } }),
      item({ id: "3", title: "Done One", stage: "available", status: "done", progress: 100 }),
    ]));
    renderActivity("member");
    await screen.findByText("Active One");
    const titles = () => screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles()).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: /Stalled/ }));
    expect(titles()).toEqual(["Stuck One"]);
    await userEvent.click(screen.getByRole("button", { name: /Done/ }));
    expect(titles()).toEqual(["Done One"]);
    await userEvent.click(screen.getByRole("button", { name: /In progress/ }));
    expect(titles()).toEqual(["Active One"]);
  });

  it("an admin's row links to the underlying detail; a member's does not", async () => {
    mockApi(feed([item({ href: "/transfers" })]));
    const { unmount } = renderActivity("admin");
    expect(await screen.findByRole("link", { name: /Details/ })).toHaveAttribute("href", "/transfers");
    unmount();
    resetCache();
    mockApi(feed([item({ href: "/transfers" })]));
    renderActivity("member");
    await screen.findByText("Dune");
    expect(screen.queryByRole("link", { name: /Details/ })).toBeNull();
  });

  it("shows the requester, and an empty state when there is nothing", async () => {
    mockApi(feed([item({})]));
    const { unmount } = renderActivity("admin");
    expect(await screen.findByText(/requested by sam/)).toBeInTheDocument();
    unmount();
    resetCache();
    mockApi(feed([]));
    renderActivity("member");
    expect(await screen.findByText("Nothing yet")).toBeInTheDocument();
  });

  it("polls through usePolled on /api/activity", async () => {
    const api = mockApi(feed([item({})]));
    renderActivity("member");
    await screen.findByText("Dune");
    expect(api.called("GET /api/activity")).toHaveLength(1);
  });
});

describe("nav", () => {
  function renderNav(role: "admin" | "member") {
    mockApi({});
    return render(
      <MemoryRouter initialEntries={["/activity"]}>
        <Routes><Route element={<Layout onLogout={() => {}} role={role} />}><Route path="/activity" element={<div />} /></Route></Routes>
      </MemoryRouter>,
    );
  }
  it("members get Activity and none of Downloads, Queue, Jobs", () => {
    renderNav("member");
    for (const a of screen.getAllByRole("link", { name: "Activity" })) expect(a).toHaveAttribute("href", "/activity");
    for (const n of ["Downloads", "Queue", "Jobs & log"]) expect(screen.queryByRole("link", { name: n })).toBeNull();
    expect(screen.queryByText("Advanced")).toBeNull();
  });
  it("admins get Transfers and History under System, and no Advanced group", () => {
    renderNav("admin");
    expect(screen.queryByText("Advanced")).toBeNull();
    const sys = NAV.find((g) => g.group === "System")!;
    expect(sys.items.map((i) => i.to)).toEqual(["/transfers", "/history", "/services", "/mounts", "/settings", "/users"]);
    for (const i of sys.items) expect(screen.getByRole("link", { name: i.label })).toHaveAttribute("href", i.to);
  });
});
