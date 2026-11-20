import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

// "Show database details", for administrators only. Off, every page shows
// only the answers. On, the dashboard says under each chart which MongoDB
// collection answered and how long it took, and the planner offers its
// PostgreSQL vs MongoDB check. Fleet analysts never see either. The switch is
// on the Administration page; remembered in this browser.

const KEY = "ycq.details";
const Details = createContext<{ on: boolean; set: (on: boolean) => void }>({ on: false, set: () => {} });

const stored = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

export function DetailsProvider({ admin, children }: { admin: boolean; children: ReactNode }) {
  const [on, setOn] = useState(stored);
  const set = (value: boolean) => {
    setOn(value);
    try {
      localStorage.setItem(KEY, value ? "1" : "0");
    } catch {
      // storage blocked: the switch still works for this visit
    }
  };
  return <Details.Provider value={{ on: admin && on, set }}>{children}</Details.Provider>;
}

export const useDetails = () => useContext(Details);

type Health = { postgres: boolean; mongodb: boolean };

// On the Administration page: whether both databases are up, and the switch.
export function DatabaseDetails() {
  const details = useDetails();
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    api<Health>("/health").then(setHealth).catch(() => setHealth({ postgres: false, mongodb: false }));
  }, []);
  const ok = !!health && health.postgres && health.mongodb;

  return (
    <div className="db-details">
      {health && (
        <span className={`pill ${ok ? "" : "bad"}`}>
          <span className="pill-dot" />
          PostgreSQL {health.postgres ? "up" : "down"}, MongoDB {health.mongodb ? "up" : "down"}
        </span>
      )}
      <label className="switch" title="Show which database answered each chart and how long it took, on every page">
        <input type="checkbox" checked={details.on} onChange={(e) => details.set(e.target.checked)} />
        <span className="switch-track"><span className="switch-thumb" /></span>
        Show database details on every page
      </label>
    </div>
  );
}
