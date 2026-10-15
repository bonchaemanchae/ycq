import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import Flows from "./pages/Flows";
import Planner from "./pages/Planner";

// One page per feature, named as in the project report. Each owner builds
// theirs in src/pages/. Add a page here to give it a tab.
const PAGES = [
  { path: "/dashboard", label: "Activity Dashboard", element: <Dashboard /> },
  { path: "/flows", label: "Flow Explorer", element: <Flows /> },
  { path: "/planner", label: "Allocation Planner", element: <Planner /> },
  { path: "/admin", label: "Administration", element: <Admin /> },
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
  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">YC</span>
          Yellow Cab Query
        </div>
        <nav>
          {PAGES.map((p) => (
            <NavLink key={p.path} to={p.path}>
              {p.label}
            </NavLink>
          ))}
        </nav>
        <Status />
      </header>
      <main>
        <Routes>
          {PAGES.map((p) => (
            <Route key={p.path} path={p.path} element={p.element} />
          ))}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}
