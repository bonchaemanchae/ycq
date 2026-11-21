import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

// Database details follow the role. Administrators see, on every page, which
// MongoDB collection answered each chart and how long it took, the planner's
// scoring details and its PostgreSQL vs MongoDB check. Fleet managers see only
// the answers.

const Details = createContext<{ on: boolean }>({ on: false });

export function DetailsProvider({ admin, children }: { admin: boolean; children: ReactNode }) {
  return <Details.Provider value={{ on: admin }}>{children}</Details.Provider>;
}

export const useDetails = () => useContext(Details);

type Health = { postgres: boolean; mongodb: boolean };

// On Data health: whether both databases are up.
export function DatabaseStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    api<Health>("/health").then(setHealth).catch(() => setHealth({ postgres: false, mongodb: false }));
  }, []);
  if (!health) return null;
  const ok = health.postgres && health.mongodb;
  return (
    <span className={`pill ${ok ? "" : "bad"}`}>
      <span className="pill-dot" />
      PostgreSQL {health.postgres ? "up" : "down"}, MongoDB {health.mongodb ? "up" : "down"}
    </span>
  );
}
