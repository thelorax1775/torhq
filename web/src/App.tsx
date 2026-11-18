/**
 * Auth gate + route table.
 *
 * The gate deliberately wraps the router rather than redirecting: an
 * unauthenticated user sees the login/setup screen at whatever URL they asked
 * for, and once the session exists the same URL renders. Deep links therefore
 * survive both a reload and a sign-in.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, apiSend, errorMessage, setCsrf, setUnauthorizedHandler } from "./lib/api.js";
import { resetCache } from "./lib/usePolled.js";
import { Layout } from "./components/Layout.js";
import { Button, Card } from "./components/ui.js";
import { Login } from "./pages/Login.js";
import { Home } from "./pages/Home.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Acquire } from "./pages/Acquire.js";
import { Catalogue } from "./pages/Catalogue.js";
import { Search } from "./pages/Search.js";
import { Activity } from "./pages/Activity.js";
import { Downloads } from "./pages/Downloads.js";
import { Queue } from "./pages/Queue.js";
import { Requests } from "./pages/Requests.js";
import { Books } from "./pages/Books.js";
import { Intake } from "./pages/Intake.js";
import { Jobs } from "./pages/Jobs.js";
import { Libraries } from "./pages/Libraries.js";
import { Mounts } from "./pages/Mounts.js";
import { Services } from "./pages/Services.js";
import { Settings } from "./pages/Settings.js";
import { Users } from "./pages/Users.js";
import { NotFound } from "./pages/NotFound.js";

interface Me { authenticated: boolean; needsSetup: boolean; csrfToken: string | null; role: "admin" | "member" | null }

export function RequireAdmin({ role, children }: { role: Me["role"]; children: ReactElement }) {
  return role === "admin" ? children : <Navigate to="/requests" replace />;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>("/api/auth/me");
      setMe(m);
      setCsrf(m.csrfToken);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Any 401 from anywhere in the app drops us back to the login screen instead
  // of leaving a half-dead UI polling a dead session.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrf(null);
      setMe((prev) => (prev?.authenticated ? { ...prev, authenticated: false, csrfToken: null } : prev));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const logout = useCallback(async () => {
    try { await apiSend("/api/auth/logout", "POST"); } catch { /* session may already be gone */ }
    setCsrf(null);
    resetCache();
    await refresh();
  }, [refresh]);

  if (error && !me) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <Card title="Can't reach the TorHQ server">
            <p className="muted small">{error}</p>
            <Button variant="primary" icon="refresh" onClick={() => { setError(null); void refresh(); }}>
              Retry
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-screen">
        <div className="muted">Loading…</div>
      </div>
    );
  }

  if (!me.authenticated) {
    return <Login needsSetup={me.needsSetup} onDone={refresh} />;
  }

  return (
    <Routes>
      <Route element={<Layout onLogout={logout} role={me.role} />}>
        <Route path="/" element={<Home role={me.role} />} />
        <Route path="/dashboard" element={<RequireAdmin role={me.role}><Dashboard /></RequireAdmin>} />
        <Route path="/catalogue" element={<Catalogue role={me.role} />} />
        <Route path="/get" element={<RequireAdmin role={me.role}><Acquire /></RequireAdmin>} />
        <Route path="/search" element={<RequireAdmin role={me.role}><Search /></RequireAdmin>} />
        <Route path="/activity" element={<Activity role={me.role} />} />
        <Route path="/downloads" element={<RequireAdmin role={me.role}><Downloads /></RequireAdmin>} />
        <Route path="/queue" element={<RequireAdmin role={me.role}><Queue /></RequireAdmin>} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/books" element={<Books role={me.role} />} />
        <Route path="/audiobooks" element={<Books role={me.role} kind="audiobook" />} />
        <Route path="/intake" element={<RequireAdmin role={me.role}><Intake /></RequireAdmin>} />
        <Route path="/jobs" element={<RequireAdmin role={me.role}><Jobs /></RequireAdmin>} />
        <Route path="/libraries" element={<RequireAdmin role={me.role}><Libraries /></RequireAdmin>} />
        <Route path="/mounts" element={<RequireAdmin role={me.role}><Mounts /></RequireAdmin>} />
        <Route path="/services" element={<RequireAdmin role={me.role}><Services /></RequireAdmin>} />
        <Route path="/settings" element={<RequireAdmin role={me.role}><Settings /></RequireAdmin>} />
        <Route path="/users" element={<RequireAdmin role={me.role}><Users /></RequireAdmin>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
