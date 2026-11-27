import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { DatabaseStatus } from "../details";
import DataHealth from "./admin/DataHealth";
import Users from "./admin/Users";
import { latestRuns, type ImportBatch, type ReconRun } from "./admin/types";
import "./admin/admin.css";

// Administration, admins only: the day-to-day work of accounts and whether
// the data is healthy. Backend routes are in api/routers/admin.py and
// api/routers/users.py. The performance results are printed by
// etl/results.py instead of shown here.
type SectionId = "users" | "health";

const SECTIONS: Record<SectionId, { title: string }> = {
  users: { title: "User management" },
  health: { title: "Data health" },
};

export default function Admin() {
  const { section: param } = useParams();
  const navigate = useNavigate();
  const section: SectionId = param && param in SECTIONS ? (param as SectionId) : "users";
  useEffect(() => {
    if (param !== section) navigate(`/admin/${section}`, { replace: true });
  }, [param, section, navigate]);

  const [batches, setBatches] = useState<ImportBatch[] | null>(null);
  const [runs, setRuns] = useState<ReconRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (section !== "health") return;
    Promise.all([api<ImportBatch[]>("/admin/imports"), api<ReconRun[]>("/admin/reconciliation")])
      .then(([b, r]) => {
        setBatches(b);
        setRuns(r);
      })
      .catch((e: Error) => setError(e.message));
  }, [section]);

  const head = (
    <div className="page-head admin-head">
      <div><h1>{SECTIONS[section].title}</h1></div>
      {section === "health" && <DatabaseStatus />}
    </div>
  );
  if (section === "users") return <section className="admin">{head}<Users /></section>;
  if (error) return <section>{head}<div className="alert error">{error}</div></section>;
  if (!batches || !runs) return <section>{head}<p className="muted">Loading…</p></section>;
  if (batches.length === 0) return <section>{head}<p className="muted">No data has been imported yet.</p></section>;

  return (
    <section className="admin">
      {head}
      <DataHealth batches={batches} latest={latestRuns(runs)} />
    </section>
  );
}
