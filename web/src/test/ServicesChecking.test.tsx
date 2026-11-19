import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { Services } from "../pages/Services.js";
import { resetCache } from "../lib/usePolled.js";
import { mockApi } from "./mockApi.js";

const svc = (kind: string) => ({
  kind, label: kind, baseUrl: `http://${kind}:1`, enabled: true, lastHealthy: null, lastStatus: null,
  secretMask: "••••", extra: {},
});

beforeEach(() => resetCache());

describe("Services while the health call is still running", () => {
  it("says Checking for configured services instead of Unknown / not set up", async () => {
    mockApi({
      "/api/services": { services: [svc("radarr"), svc("sonarr")], kinds: ["radarr", "sonarr", "lidarr"] },
      // Never answers: the health call is slow.
      "/api/status/health": () => new Promise((r) => setTimeout(() => r({ health: {}, services: [] }), 200)),
    });
    render(<MemoryRouter><Services /></MemoryRouter>);
    expect(await screen.findByText("2 checking…")).toBeInTheDocument();
    expect(screen.getAllByText("Checking…").length).toBe(2);
    expect(screen.getByText("1 not set up")).toBeInTheDocument();
    // Only the unconfigured lidarr row may still read Unknown.
    expect(screen.getAllByText("Unknown").length).toBe(1);
  });
});
