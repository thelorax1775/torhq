/**
 * Auth gate + route table.
 *
 * The gate deliberately wraps the router rather than redirecting: an
 * unauthenticated user sees the login/setup screen at whatever URL they asked
 * for, and once the session exists the same URL renders. Deep links therefore
 * survive both a reload and a sign-in.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, apiSend, errorMessage, setCsrf, setUnauthorizedHandler } from "./lib/api.js";
import { resetCache } from "./lib/usePolled.js";
import { Layout } from "./components/Layout.js";
import { Button, Card } from "./components/ui.js";
import { Login } from "./pages/Login.js";
import { Home } from "./pages/Home.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Discover } from "./pages/Discover.js";
import { Search } from "./pages/Search.js";
import { Activity } from "./pages/Activity.js";
import { Books } from "./pages/Books.js";
import { Imports } from "./pages/Imports.js";
import { History } from "./pages/History.js";
import { Transfers } from "./pages/Transfers.js";
import { Libraries } from "./pages/Libraries.js";
import { Mounts } from "./pages/Mounts.js";
import { Services } from "./pages/Services.js";
import { Settings } from "./pages/Settings.js";
import { Users } from "./pages/Users.js";
import { NotFound } from "./pages/NotFound.js";

interface Me { authenticated: boolean; needsSetup: boolean; csrfToken: string | null; role: "admin" | "member" | null }

/** Old bookmarks keep working: same query string, new path. */
export function Redirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

export function RequireAdmin({ role, children }: { role: Me["role"]; children: ReactElement }) {
  return role === "admin" ? children : <Navigate to="/" replace />;
}

/**
 * Pages that were folded into others. Each old URL lands on the page that now
 * does its job, so bookmarks keep working:
 *   /get       -> /           (Search; pick a release under Options > Choose release)
 *   /requests  -> /activity   (admins land on its Requests tab)
 *   /downloads, /queue -> /transfers
 *   /jobs      -> /history
 *   /intake    -> /imports
 */
export function AppRoutes({ role, onLogout }: { role: Me["role"]; onLogout: () => void }) {
  const admin = (el: ReactElement) => <RequireAdmin role={role}>{el}</RequireAdmin>;
  return (
    <Routes>
      <Route element={<Layout onLogout={onLogout} role={role} />}>
        <Route path="/" element={<Home role={role} />} />
        <Route path="/dashboard" element={admin(<Dashboard />)} />
        <Route path="/discover" element={<Discover role={role} />} />
        <Route path="/catalogue" element={<Redirect to="/discover" />} />
        <Route path="/get" element={<Redirect to="/" />} />
        <Route path="/search" element={admin(<Search />)} />
        <Route path="/activity" element={<Activity role={role} />} />
        <Route path="/requests" element={<Navigate to={role === "admin" ? "/activity?view=requests" : "/activity"} replace />} />
        <Route path="/transfers" element={admin(<Transfers />)} />
        <Route path="/downloads" element={<Redirect to="/transfers" />} />
        <Route path="/queue" element={<Redirect to="/transfers" />} />
        <Route path="/history" element={admin(<History />)} />
        <Route path="/jobs" element={<Redirect to="/history" />} />
        <Route path="/books" element={<Books role={role} />} />
        <Route path="/audiobooks" element={<Books role={role} kind="audiobook" />} />
        <Route path="/imports" element={admin(<Imports />)} />
        <Route path="/intake" element={<Redirect to="/imports" />} />
        <Route path="/libraries" element={admin(<Libraries />)} />
        <Route path="/mounts" element={admin(<Mounts />)} />
        <Route path="/services" element={admin(<Services />)} />
        <Route path="/settings" element={admin(<Settings />)} />
        <Route path="/users" element={admin(<Users />)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
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

  return <AppRoutes role={me.role} onLogout={logout} />;
}
