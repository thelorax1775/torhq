/**
 * Sign-in / first-run admin creation. Rendered in place of the whole app, so
 * the requested URL is preserved and the user lands back on it after signing in.
 */
import { useState, type FormEvent } from "react";
import { apiSend, setCsrf } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { Alert, Button, Card, Field } from "../components/ui.js";
import { Icon } from "../components/Icon.js";

export function Login({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void | Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = useMutation(async () => {
    const path = needsSetup ? "/api/auth/register" : "/api/auth/login";
    const r = await apiSend<{ csrfToken: string }>(path, "POST", { username, password });
    setCsrf(r.csrfToken);
    return r;
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const r = await submit.run();
    if (r.ok) await onDone();
  }

  const tooShort = needsSetup && password.length > 0 && password.length < 8;

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <Card>
          <div className="brand" style={{ padding: 0, marginBottom: "var(--s5)" }}>
            <span className="mark"><Icon name="download" size={16} /></span>
            <span>Tor<em>HQ</em></span>
          </div>
          <h3 style={{ marginBottom: "var(--s4)" }}>{needsSetup ? "Create the admin account" : "Sign in"}</h3>

          <Field label="Username" htmlFor="login-username">
            <input
              id="login-username"
              className="input"
              value={username}
              autoFocus
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field
            label="Password"
            hint={needsSetup ? "At least 8 characters. This is the only account TorHQ creates." : undefined}
            htmlFor="login-password"
            error={tooShort ? "Password must be at least 8 characters." : undefined}
          >
            <input
              id="login-password"
              className="input"
              type="password"
              value={password}
              autoComplete={needsSetup ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {submit.error && <div className="mt-3"><Alert tone="err" title="Sign-in failed">{submit.error}</Alert></div>}

          <div className="mt-4">
            <Button
              type="submit"
              variant="primary"
              className="btn-block"
              pending={submit.pending}
              disabled={!username || !password || tooShort}
            >
              {needsSetup ? "Create account & continue" : "Sign in"}
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}
