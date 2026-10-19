import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { LOGOUT_EVENT, api, getToken, logout, type User } from "./api";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import Flows from "./pages/Flows";
import Login from "./pages/Login";
import Planner from "./pages/Planner";

// One page per feature, named as in the project report. Each owner builds
// theirs in src/pages/. Add a page here to give it a tab. `admin` pages are
// only shown to admins (the backend refuses everyone else as well).
const PAGES = [
  { path: "/dashboard", label: "Activity Dashboard", element: <Dashboard /> },
  { path: "/flows", label: "Flow Explorer", element: <Flows /> },
  { path: "/planner", label: "Allocation Planner", element: <Planner /> },
  { path: "/admin", label: "Administration", element: <Admin />, admin: true },
];

type Health = { postgres: boolean; mongodb: boolean; months_loaded: string[] };

// Header badge: are both databases up, and which months are loaded.
function Status() {
  const [text, setText] = useState("checking backend...");
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    api<Health>("/health")
      .then((h) => {
        setOk(h.postgres && h.mongodb);
        setText(
          `PostgreSQL ${h.postgres ? "up" : "down"} · MongoDB ${h.mongodb ? "up" : "down"} · ` +
          `months: ${h.months_loaded.join(", ") || "none"}`);
      })
      .catch(() => {
        setOk(false);
        setText("backend not reachable");
      });
  }, []);
  return <span className={`status ${ok === null ? "" : ok ? "ok" : "down"}`}>{text}</span>;
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
  const pages = PAGES.filter((p) => !p.admin || user?.roles.includes("admin"));

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">YC</span>
          Yellow Cab Query
        </div>
        {user && (
          <nav>
            {pages.map((p) => (
              <NavLink key={p.path} to={p.path}>
                {p.label}
              </NavLink>
            ))}
          </nav>
        )}
        <Status />
        {user && (
          <div className="account">
            <span title={user.roles.join(", ")}>{user.email}</span>
            <button onClick={logout}>Log out</button>
          </div>
        )}
      </header>
      <main>
        {user ? (
          <Routes>
            {pages.map((p) => (
              <Route key={p.path} path={p.path} element={p.element} />
            ))}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        ) : (
          <Login onLogin={setUser} />
        )}
      </main>
    </div>
  );
}
