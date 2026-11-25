import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { DatabaseStatus } from "../details";
import DataHealth from "./admin/DataHealth";
import Performance from "./admin/Performance";
import Pipeline from "./admin/Pipeline";
import Users from "./admin/Users";
import { latestRuns, type BenchmarkRun, type ImportBatch, type ReconRun } from "./admin/types";
import "./admin/admin.css";

// Two sidebar groups, both admin only. Administration holds the day-to-day
// work (accounts, and whether the data is healthy); Database evaluation holds
// the evidence behind the database design. Backend routes are in
// api/routers/admin.py.
type Area = "admin" | "evaluation";
type SectionId = "users" | "health" | "pipeline" | "performance";

const SECTIONS: Record<SectionId, { area: Area; title: string; question?: string }> = {
  users: {
    area: "admin", title: "User management",
  },
  health: {
    area: "admin", title: "Data health",
  },
  pipeline: {
    area: "evaluation", title: "Data pipeline",
    question: "How each TLC row is checked, stored in PostgreSQL and summarised into MongoDB, step by step",
  },
  performance: { area: "evaluation", title: "Performance" },
};
const FIRST: Record<Area, SectionId> = { admin: "users", evaluation: "pipeline" };

export default function Admin({ area }: { area: Area }) {
  const { section: raw } = useParams();
  const param = raw === "benchmarks" ? "performance" : raw;   // the page's old address
  const navigate = useNavigate();
  const section: SectionId =
    param && param in SECTIONS && SECTIONS[param as SectionId].area === area ? (param as SectionId) : FIRST[area];
  useEffect(() => {
    if (param !== section) navigate(`/${area}/${section}`, { replace: true });
  }, [param, section, area, navigate]);

  const [batches, setBatches] = useState<ImportBatch[] | null>(null);
  const [runs, setRuns] = useState<ReconRun[] | null>(null);
  const [bench, setBench] = useState<BenchmarkRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<ImportBatch[]>("/admin/imports"),
      api<ReconRun[]>("/admin/reconciliation"),
      api<BenchmarkRun>("/admin/benchmarks"),
    ])
      .then(([b, r, bm]) => {
        setBatches(b);
        setRuns(r);
        setBench(bm);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const head = (
    <div className="page-head admin-head">
      <div>
        <h1>{SECTIONS[section].title}</h1>
        {SECTIONS[section].question && <p className="muted">{SECTIONS[section].question}</p>}
      </div>
      {section === "health" && <DatabaseStatus />}
    </div>
  );
  if (section === "users") return <section className="admin">{head}<Users /></section>;
  if (error) return <section>{head}<div className="alert error">{error}</div></section>;
  if (!batches || !runs || !bench) return <section>{head}<p className="muted">Loading…</p></section>;
  if (batches.length === 0) return <section>{head}<p className="muted">No data has been imported yet.</p></section>;

  const latest = latestRuns(runs);
  return (
    <section className="admin">
      {head}
      {section === "health" && <DataHealth batches={batches} latest={latest} />}
      {section === "pipeline" && <Pipeline batches={batches} latest={latest} />}
      {section === "performance" && <Performance run={bench} />}
    </section>
  );
}
