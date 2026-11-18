import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { Transfers } from "../pages/Transfers.js";
import { resetCache } from "../lib/usePolled.js";
import { mockApi } from "./mockApi.js";

const HASH_ARR = "a".repeat(40);
const HASH_LOOSE = "b".repeat(40);
const torrent = (over: Record<string, unknown>) => ({
  hash: HASH_LOOSE, name: "Loose.Game-GRP", category: "torhq-games", state: "downloading", progress: 0.5,
  dlspeed: 1000, size: 2_000_000_000, eta: 600, addedOn: 1, ...over,
});

function routes(over: Record<string, unknown> = {}) {
  return {
    "/api/downloads": { torrents: [
      torrent({ hash: HASH_ARR, name: "Dune.Part.Two.2024.2160p", category: "radarr", progress: 0.25 }),
      torrent({}),
    ] },
    "/api/queue": { items: [{
      service: "radarr", id: 5, title: "Dune.Part.Two.2024.2160p", mediaTitle: "Dune: Part Two", status: "downloading",
      trackedDownloadState: "downloading", trackedDownloadStatus: "ok", statusMessages: [], size: 100, sizeleft: 75,
      downloadId: HASH_ARR.toUpperCase(), libraryId: 12,
    }], unavailable: [{ service: "lidarr", detail: "not configured" }] },
    "/api/status/slskd": { downloads: [{ username: "peer1", files: [
      { filename: "Music\\Radiohead\\OK Computer\\01 Airbag.flac", state: "InProgress", percentComplete: 40 },
      { filename: "Music\\Radiohead\\OK Computer\\02 Paranoid Android.flac", state: "Completed, Succeeded", percentComplete: 100 },
    ] }] },
    "/api/pipeline/check": { checks: [] },
    "/api/pipeline/failed-imports": { items: [] },
    ...over,
  };
}

function renderPage() {
  return render(<MemoryRouter><Transfers /></MemoryRouter>);
}

const rows = async () => {
  const table = await screen.findByRole("table", { name: "Transfers" });
  return within(table).getAllByRole("row").slice(1);
};

beforeEach(() => resetCache());

describe("Transfers", () => {
  it("shows qBittorrent, Soulseek and *arr queue rows in one table, an *arr item merged with its torrent", async () => {
    mockApi(routes());
    renderPage();
    await screen.findByText("Dune: Part Two");
    await screen.findByText("OK Computer");
    const r = await rows();
    expect(r.map((x) => x.getAttribute("data-source")).sort()).toEqual(["arr", "slskd", "torrent"]);
    const arr = r.find((x) => x.getAttribute("data-source") === "arr")!;
    expect(arr).toHaveTextContent("Radarr via qBittorrent");
    expect(arr).toHaveTextContent("Downloading");
    expect(within(arr).getByRole("link", { name: "Dune: Part Two" })).toHaveAttribute("href", "/activity?item=radarr%3A12");
    const loose = r.find((x) => x.getAttribute("data-source") === "torrent")!;
    expect(loose).toHaveTextContent("qBittorrent");
    expect(within(loose).getByRole("link", { name: "Loose.Game-GRP" })).toHaveAttribute("href", `/activity?item=torrent%3A${HASH_LOOSE}`);
    const sk = r.find((x) => x.getAttribute("data-source") === "slskd")!;
    expect(sk).toHaveTextContent("Soulseek");
    expect(sk).toHaveTextContent("2 files from peer1");
    expect(within(sk).getByRole("link", { name: "OK Computer" })).toHaveAttribute("href", "/activity?item=slskd%3Apeer1");
    // Plain column names; no qBittorrent categories on the default view.
    const head = within(screen.getByRole("table", { name: "Transfers" })).getAllByRole("columnheader").map((h) => h.textContent);
    expect(head.slice(0, 6)).toEqual(["Name", "From", "Status", "Progress", "Size", "Time left"]);
    expect(screen.queryByText("torhq-games")).toBeNull();
    // A service that is simply not set up is a quiet note, not a warning.
    expect(screen.getByText(/Not set up, so not shown: Lidarr/)).toBeInTheDocument();
  });

  it("pauses a torrent and removes an *arr queue item through the existing routes", async () => {
    const api = mockApi(routes({
      "POST /api/downloads/action": { ok: true },
      "POST /api/queue/radarr/5/remove": { ok: true },
    }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Pause Loose.Game-GRP" }));
    expect(api.called("POST /api/downloads/action")[0]!.body).toEqual({ action: "pause", hashes: [HASH_LOOSE] });

    await userEvent.click(screen.getByRole("button", { name: "Remove Dune: Part Two" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText(/blocklist/));
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.called("POST /api/queue/radarr/5/remove")[0]!.body).toEqual({ removeFromClient: true, blocklist: true });
  });

  it("deleting a torrent's files needs DELETE typed", async () => {
    const api = mockApi(routes({ "POST /api/downloads/action": { ok: true } }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Remove Loose.Game-GRP" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Also delete the downloaded files"));
    const go = within(dialog).getByRole("button", { name: "Remove and delete files" });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByPlaceholderText("DELETE"), "DELETE");
    await userEvent.click(go);
    expect(api.called("POST /api/downloads/action")[0]!.body).toEqual({ action: "deleteWithFiles", hashes: [HASH_LOOSE] });
  });

  it("lists import problems above the table", async () => {
    mockApi(routes({
      "/api/pipeline/check": { checks: [{ id: "c", label: "Radarr can see qBittorrent's folder", ok: false, severity: "error", detail: "/data/radarr is not visible", fix: "Mount it." }] },
      "/api/pipeline/failed-imports": { items: [{ service: "sonarr", id: 3, title: "Show.S01E01", reason: "No files found", downloadId: HASH_ARR }] },
    }));
    renderPage();
    expect(await screen.findByText("Radarr can see qBittorrent's folder")).toBeInTheDocument();
    expect(await screen.findByText(/Sonarr refused it: No files found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry import" })).toBeEnabled();
  });
});
