import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { setCsrf, setUnauthorizedHandler } from "../lib/api.js";
import { resetCache } from "../lib/usePolled.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrf(null);
  setUnauthorizedHandler(null);
  resetCache();
});
