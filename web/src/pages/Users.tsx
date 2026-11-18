/**
 * Users — friend accounts that can search/request media without reaching any
 * admin page. Creating an account here always sets role: "member" — a second
 * admin can never be created from this page, only at first-run setup.
 *
 * Consumes `GET /api/users`, `POST /api/users`, `POST /api/users/:id/password`,
 * `DELETE /api/users/:id`.
 */
import { useState, type FormEvent } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import {
  Alert, Async, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader,
  TableWrap, TextField,
} from "../components/ui.js";

interface UserRow { id: number; username: string; role: "admin" | "member"; createdAt: number }
interface UsersResponse { users: UserRow[] }

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function Users() {
  const q = usePolled<UsersResponse>("/api/users", 0);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [removeTarget, setRemoveTarget] = useState<UserRow | null>(null);

  const create = useMutation(
    (body: { username: string; password: string }) =>
      apiSend<{ ok: true; user: UserRow }>("/api/users", "POST", body),
    { invalidates: ["/api/users"] },
  );
  const reset = useMutation(
    (input: { id: number; password: string }) =>
      apiSend<{ ok: true }>(`/api/users/${input.id}/password`, "POST", { password: input.password }),
  );
  const remove = useMutation(
    (u: UserRow) => apiSend<{ ok: true }>(`/api/users/${u.id}`, "DELETE"),
    { invalidates: ["/api/users"] },
  );

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    const r = await create.run({ username, password });
    if (r.ok) { setUsername(""); setPassword(""); }
  }

  const canCreate = username.trim() !== "" && password.length >= 8;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Accounts for you and your friends: a friend can search, ask for things and follow them in Activity, and never sees the admin pages."
      />

      <Card title="Accounts" icon="shield">
        <Async q={q} what="users">
          {(data) => (
            data.users.length === 0 ? (
              <EmptyState icon="shield" title="No accounts yet" message="This shouldn't happen — the admin account is created at first run." />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Role</th>
                      <th>Created</th>
                      <th className="shrink" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((u) => (
                      <tr key={u.id}>
                        <td>{u.username}</td>
                        <td className="nowrap"><Badge tone={u.role === "admin" ? "info" : "neutral"}>{u.role}</Badge></td>
                        <td className="nowrap">{fmtDate(u.createdAt)}</td>
                        <td className="shrink row-nowrap">
                          {u.role === "member" && (
                            <>
                              <Button
                                size="sm" variant="ghost" icon="settings" title="Reset password"
                                aria-label={`Reset password for ${u.username}`}
                                onClick={() => { setResetPassword(""); reset.reset(); setResetTarget(u); }}
                              />
                              <Button
                                size="sm" variant="ghost" icon="trash" title="Revoke"
                                aria-label={`Revoke ${u.username}`}
                                onClick={() => { remove.reset(); setRemoveTarget(u); }}
                              />
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )
          )}
        </Async>
      </Card>

      <Card title="Add a friend" icon="plus">
        {create.error && <Alert tone="err" title="Could not create account">{create.error}</Alert>}
        {create.data && !create.error && (
          <Alert tone="ok" title="Account created">
            "{create.data.user.username}" can now sign in and use Requests, Downloads, Queue and Jobs.
          </Alert>
        )}
        <form className="stack" onSubmit={submitCreate}>
          <div className="grid-2">
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="sam"
              required
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="At least 8 characters."
              required
            />
          </div>
          <div className="row">
            <Button type="submit" variant="primary" icon="plus" pending={create.pending} disabled={!canCreate}>
              Create account
            </Button>
          </div>
        </form>
      </Card>

      {resetTarget && (
        <ConfirmDialog
          title={`Reset password for ${resetTarget.username}`}
          confirmLabel="Set new password"
          tone="primary"
          pending={reset.pending}
          error={reset.error}
          onClose={() => setResetTarget(null)}
          onConfirm={async () => {
            const r = await reset.run({ id: resetTarget.id, password: resetPassword });
            if (r.ok) setResetTarget(null);
          }}
          extra={
            <TextField
              label="New password"
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              hint="At least 8 characters. Signs the account out everywhere else."
              autoFocus
            />
          }
          body={<p>{resetTarget.username} will need this new password next time they sign in.</p>}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title={`Revoke ${removeTarget.username}?`}
          confirmLabel="Revoke account"
          tone="danger-solid"
          pending={remove.pending}
          error={remove.error}
          onClose={() => setRemoveTarget(null)}
          onConfirm={async () => {
            const r = await remove.run(removeTarget);
            if (r.ok) setRemoveTarget(null);
          }}
          body={<p>{removeTarget.username} is signed out immediately and can no longer log in. This does not touch anything they requested — those stay in the library.</p>}
        />
      )}
    </>
  );
}
