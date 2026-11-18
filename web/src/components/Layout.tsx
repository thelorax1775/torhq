/**
 * App shell: persistent sidebar + sticky header, off-canvas drawer on narrow
 * screens. Navigation is real `<NavLink>`s, so every view is a deep link and
 * keyboard/browser navigation works without any custom handling.
 */
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Icon, type IconName } from "./Icon.js";
import { Button } from "./ui.js";
import { usePolled } from "../lib/usePolled.js";
import { speed } from "../lib/format.js";

interface NavItem {
  to: string; label: string; icon: IconName; end?: boolean; adminOnly?: boolean;
  /** Which admin attention count (GET /api/attention) shows as a badge on this link. */
  badge?: keyof Attention;
}

/** What waits for the admin: member requests (Activity) and finished downloads to approve (Imports). */
export interface Attention { requests: number; imports: number }

export const NAV: Array<{ group: string; primary?: boolean; items: NavItem[] }> = [
  {
    group: "Main",
    primary: true,
    items: [
      { to: "/", label: "Search", icon: "search", end: true },
      { to: "/discover", label: "Discover", icon: "grid" },
      { to: "/activity", label: "Activity", icon: "activity", badge: "requests" },
    ],
  },
  {
    group: "Library",
    items: [
      { to: "/imports", label: "Imports to approve", icon: "inbox", adminOnly: true, badge: "imports" },
      { to: "/libraries", label: "Libraries", icon: "book", adminOnly: true },
    ],
  },
  {
    group: "System",
    items: [
      { to: "/transfers", label: "Transfers", icon: "download", adminOnly: true },
      { to: "/history", label: "History", icon: "clock", adminOnly: true },
      { to: "/services", label: "Services", icon: "plug", adminOnly: true },
      { to: "/mounts", label: "Mounts", icon: "server", adminOnly: true },
      { to: "/settings", label: "Settings", icon: "settings", adminOnly: true },
      { to: "/users", label: "Users", icon: "shield", adminOnly: true },
    ],
  },
];

/** Pages that are no longer in the nav but keep working, so bookmarks survive. */
const LEGACY_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard", "/books": "Books", "/audiobooks": "Audiobooks", "/catalogue": "Discover",
  "/search": "Search indexers",
};

/** Route → header title. Falls back to the nav label lookup. */
export function titleForPath(pathname: string): string {
  for (const g of NAV) {
    for (const item of g.items) {
      if (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)) {
        return item.label;
      }
    }
  }
  return LEGACY_TITLES[pathname] ?? "TorHQ";
}

interface TransferSummary { transfer?: { dlspeed?: number; upspeed?: number } }

export function Layout({ onLogout, role }: { onLogout: () => void; role: "admin" | "member" | null }) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const visibleNav = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || role === "admin") }))
    .filter((g) => g.items.length > 0);

  // Close the drawer on navigation, and on Escape.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const primary = visibleNav.find((g) => g.primary)?.items ?? [];

  // Global transfer readout. Shares the Transfers page's cache entry, and stays
  // hidden when qBittorrent isn't configured or the route isn't there yet.
  const transfer = usePolled<TransferSummary>("/api/downloads", 15000);
  const t = transfer.data?.transfer;

  // Admin badges: requests waiting in Activity, imports waiting to be approved.
  const attention = usePolled<Attention>(role === "admin" ? "/api/attention" : null, 30000);
  const countOf = (item: NavItem) => (item.badge && attention.data ? attention.data[item.badge] : 0);
  const Count = ({ item }: { item: NavItem }) => {
    const n = countOf(item);
    return n > 0 ? <span className="count count-attn" aria-label={`${n} waiting`}>{n}</span> : null;
  };

  return (
    <div className={`shell${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" id="app-nav" aria-label="Main">
        <NavLink to="/" className="brand">
          <span className="mark"><Icon name="download" size={16} /></span>
          <span>Tor<em>HQ</em></span>
        </NavLink>

        <nav>
          {visibleNav.map((g) => (
            <div className="nav-group" key={g.group}>
              {!g.primary && <div className="nav-group-label">{g.group}</div>}
              {g.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                  <Count item={item} />
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="nav-link" style={{ width: "100%" }} onClick={onLogout}>
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {navOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

      <div>
        <header className="topbar">
          <Button
            className="nav-toggle"
            variant="ghost"
            icon="menu"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((v) => !v)}
          />
          <h1>{titleForPath(location.pathname)}</h1>
          <div className="spacer" />
          {t && (
            <div className="transfer-chip" title="qBittorrent transfer rates">
              <span className="dl"><Icon name="down" size={12} /> {speed(t.dlspeed ?? 0)}</span>
              <span className="ul"><Icon name="up" size={12} /> {speed(t.upspeed ?? 0)}</span>
            </div>
          )}
        </header>
        <main className="content">
          {/* Keyed on the path so navigating away clears a failed render, and so
              the boundary is scoped to one page rather than the whole session. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {/* Phone only (CSS): the primary pages one tap away. Admins reach the rest through the menu. */}
      <nav className="tabbar" aria-label="Primary">
        {primary.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `tab-link${isActive ? " active" : ""}`}>
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
            <Count item={item} />
          </NavLink>
        ))}
        <button type="button" className="tab-link" aria-expanded={navOpen} aria-controls="app-nav" onClick={() => setNavOpen((v) => !v)}>
          <Icon name="menu" size={20} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
