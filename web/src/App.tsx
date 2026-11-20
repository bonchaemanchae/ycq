import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { LOGOUT_EVENT, api, getToken, logout, type User } from "./api";
import { DetailsProvider } from "./details";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Planner from "./pages/Planner";

// The app shell: a sidebar with the three pages and their sections, a top bar
// with the loaded data, and the page.
// A fleet manager reads it top to bottom: look at demand, find shortages,
// see where trips go (the Flow Explorer, opened by clicking a zone), then plan.

type NavItem = { to: string; label: string };
type NavGroup = { base: string; label: string; icon: ReactNode; items: NavItem[]; admin?: boolean };

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

const NAV: NavGroup[] = [
  {
    base: "/dashboard", label: "Analytical Dashboard",
    icon: icon("M4 13h4v7H4zM10 4h4v16h-4zM16 9h4v11h-4z"),
    items: [
      { to: "/dashboard/overview", label: "Zone maps" },
      { to: "/dashboard/trends", label: "Daily trends" },
    ],
  },
  {
    base: "/planner", label: "Allocation Planner",
    icon: icon("M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),
    items: [
      { to: "/planner/build", label: "Build a plan" },
      { to: "/planner/saved", label: "Saved plans" },
    ],
  },
  {
    base: "/admin", label: "Administration", admin: true,
    icon: icon("M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7l8-4zM9 12l2 2 4-4"),
    items: [
      { to: "/admin/loading", label: "Data loading" },
      { to: "/admin/check", label: "Database check" },
      { to: "/admin/benchmarks", label: "Benchmarks" },
      { to: "/admin/users", label: "Users" },
    ],
  },
];

type Health = { postgres: boolean; mongodb: boolean; months_loaded: string[] };

const MONTH = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" });

// "Jan–Mar 2026" for the loaded months.
function monthsLabel(months: string[]) {
  if (months.length === 0) return "no data loaded";
  const first = months[0], last = months[months.length - 1];
  const year = last.slice(0, 4);
  return first === last ? `${MONTH(first)} ${year}` : `${MONTH(first)}–${MONTH(last)} ${year}`;
}

// Top bar: which months of trip data are loaded.
function TopBar() {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    api<Health>("/health").then(setHealth).catch(() => setDown(true));
  }, []);
  const ok = !!health && health.postgres && health.mongodb;

  return (
    <div className="topbar">
      <span className={`pill ${down || (health && !ok) ? "bad" : ""}`} title="Months of TLC trip data loaded">
        <span className="pill-dot" />
        {down ? "Backend not reachable" : health ? `Data: ${monthsLabel(health.months_loaded)}` : "Checking…"}
      </span>
    </div>
  );
}

function Sidebar({ user, groups }: { user: User; groups: NavGroup[] }) {
  const { pathname } = useLocation();
  const initials = (user.display_name || user.email).split(/[\s@.]/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("");

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">YC</span>
        <div>
          <div className="brand-name">Yellow Cab Query</div>
          <div className="brand-sub">Fleet planning on NYC taxi data</div>
        </div>
      </div>

      <nav className="side-nav" aria-label="Pages">
        {groups.map((g) => {
          const here = pathname.startsWith(g.base);
          return (
            <div key={g.base} className="side-group">
              <NavLink to={g.items[0].to} className={`side-page ${here ? "here" : ""}`}>
                {g.icon}{g.label}
              </NavLink>
              {here && (
                <div className="side-items">
                  {g.items.map((i) => (
                    <NavLink key={i.to} to={i.to} className="side-item">{i.label}</NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="account">
        <span className="avatar" aria-hidden="true">{initials}</span>
        <div className="account-text">
          <div className="account-name">{user.display_name || user.email}</div>
          <div className="account-role">{user.roles.includes("admin") ? "Administrator" : "Fleet analyst"}</div>
        </div>
        <button className="link" onClick={logout}>Log out</button>
      </div>
    </aside>
  );
}

export default function App() {
  // undefined while checking a token kept from earlier in this tab.
  const [user, setUser] = useState<User | null | undefined>(getToken() ? undefined : null);

  useEffect(() => {
    if (user === undefined) api<User>("/auth/me").then(setUser).catch(() => setUser(null));
    const onLogout = () => setUser(null);
    window.addEventListener(LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(LOGOUT_EVENT, onLogout);
  }, []);

  if (user === undefined) return null;
  if (user === null) return <Login onLogin={setUser} />;

  const admin = user.roles.includes("admin");
  const groups = NAV.filter((g) => !g.admin || admin);

  return (
    <DetailsProvider admin={admin}>
      <div className="shell">
        <Sidebar user={user} groups={groups} />
        <div className="workspace">
          <TopBar />
          <main>
            <Routes>
              <Route path="/dashboard/:tab?" element={<Dashboard />} />
              <Route path="/planner/:tab?" element={<Planner />} />
              {admin && <Route path="/admin/:section?" element={<Admin />} />}
              {/* the Flow Explorer is now a panel on the dashboard and planner maps */}
              <Route path="/flows" element={<Navigate to="/dashboard/overview" replace />} />
              <Route path="*" element={<Navigate to="/dashboard/overview" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </DetailsProvider>
  );
}
