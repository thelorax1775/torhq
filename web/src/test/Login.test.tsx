import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Login } from "../pages/Login.js";
import { mockApi } from "./mockApi.js";

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Username"), "alice");
  await user.type(screen.getByLabelText("Password"), "wrong-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("Login", () => {
  it("shows the server's error on a 401 and does not continue", async () => {
    const api = mockApi({ "POST /api/auth/login": { status: 401, body: { error: "invalid credentials" } } });
    const onDone = vi.fn();
    render(<Login needsSetup={false} onDone={onDone} />);
    await fillAndSubmit(userEvent.setup());
    expect(await screen.findByText("invalid credentials")).toBeInTheDocument();
    expect(screen.getByText("Sign-in failed")).toBeInTheDocument();
    expect(api.called("POST /api/auth/login")[0].body).toEqual({ username: "alice", password: "wrong-password" });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("calls onDone after a successful sign-in", async () => {
    mockApi({ "POST /api/auth/login": { username: "alice", csrfToken: "tok" } });
    const onDone = vi.fn();
    render(<Login needsSetup={false} onDone={onDone} />);
    await fillAndSubmit(userEvent.setup());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
