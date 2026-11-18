import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RequireAdmin } from "../App.js";

function renderAt(role: "admin" | "member" | null) {
  return render(
    <MemoryRouter initialEntries={["/users"]}>
      <Routes>
        <Route path="/users" element={<RequireAdmin role={role}><div>admin page</div></RequireAdmin>} />
        <Route path="/" element={<div>member home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAdmin", () => {
  it("redirects a member to the member home", () => {
    renderAt("member");
    expect(screen.getByText("member home")).toBeInTheDocument();
    expect(screen.queryByText("admin page")).toBeNull();
  });
  it("redirects when there is no role", () => {
    renderAt(null);
    expect(screen.getByText("member home")).toBeInTheDocument();
  });
  it("renders the page for an admin", () => {
    renderAt("admin");
    expect(screen.getByText("admin page")).toBeInTheDocument();
  });
});
