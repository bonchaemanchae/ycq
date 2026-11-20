import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { DatabaseDetails } from "../details";
import Benchmarks from "./admin/Benchmarks";
import ImportsTable from "./admin/ImportsTable";
import PipelineDiagram from "./admin/PipelineDiagram";
import ReasonBars from "./admin/ReasonBars";
import Reconciliation from "./admin/Reconciliation";
import RejectedRows from "./admin/RejectedRows";
import Users from "./admin/Users";
import { latestRuns, n, type BenchmarkRun, type ImportBatch, type ReconRun } from "./admin/types";
import "./admin/admin.css";

type SectionId = "loading" | "check" | "benchmarks" | "users";
const SECTIONS: Record<SectionId, { title: string; question: string }> = {
  loading: {
    title: "Data loading",
    question: "Did every month of TLC trips load, and what was rejected or flagged and why? No source row is lost: "
      + "each one is either kept or stored as rejected with its reason.",
  },
  check: {
    title: "Database check",
    question: "Do PostgreSQL and MongoDB still agree, does every saved view still have an owner, and has any saved "
      + "plan been changed after it was sealed?",
  },
  benchmarks: {
    title: "Benchmarks",
    question: "Which database answers the app's questions faster, on the same data, with the answers checked to match.",
  },
  users: {
    title: "Users",
    question: "Create and delete analyst and admin accounts. Deleting a user also deletes their plans and saved views.",
  },
};

// Administration, admin role only. Backend routes are in
// api/routers/admin.py. One section per question, chosen in the sidebar.
export default function Admin() {
  const { section: param } = useParams();
  const navigate = useNavigate();
  const section: SectionId = param && param in SECTIONS ? (param as SectionId) : "loading";
  useEffect(() => {
    if (param !== section) navigate(`/admin/${section}`, { replace: true });
  }, [param, section, navigate]);

  const [batches, setBatches] = useState<ImportBatch[] | null>(null);
  const [runs, setRuns] = useState<ReconRun[] | null>(null);
  const [bench, setBench] = useState<BenchmarkRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

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
        if (b.length) setSelected(b[b.length - 1].import_batch_id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const head = (
    <div className="page-head admin-head">
      <div>
      <h1>{SECTIONS[section].title}</h1>
      <p className="muted">{SECTIONS[section].question}</p>
      </div>
      <DatabaseDetails />
    </div>
  );
  if (section === "users") return <section className="admin">{head}<Users /></section>;
  if (error) return <section>{head}<div className="alert error">{error}</div></section>;
  if (!batches || !runs || !bench) return <section>{head}<p className="muted">Loading…</p></section>;
  if (batches.length === 0) return <section>{head}<p className="muted">No data has been imported yet.</p></section>;

  const latest = latestRuns(runs);
  const failed = batches.filter((b) => latest.get(b.month)?.passed !== true).map((b) => b.month);
  const batch = batches.find((b) => b.import_batch_id === selected) ?? batches[batches.length - 1];
  const months = batches.map((b) => b.month);

  const banner = (
    <div className={`banner ${failed.length ? "bad" : "ok"}`} role="status">
      <span className="banner-icon" aria-hidden="true">{failed.length ? "!" : "✓"}</span>
      <div>
        <strong>
          {failed.length
            ? `Needs attention: ${failed.join(", ")} ${failed.length === 1 ? "has" : "have"} not passed the database cross-check`
            : `All good: ${months.length} ${months.length === 1 ? "month" : "months"} loaded and both databases agree`}
        </strong>
        <span className="muted">. {months[0]}{months.length > 1 ? ` to ${months[months.length - 1]}` : ""},{" "}
          {n(batches.reduce((s, b) => s + b.rows_accepted, 0))} trips available for analysis</span>
      </div>
    </div>
  );

  return (
    <section className="admin">
      {head}
      {section === "check" && banner}
      {section === "loading" && failed.length > 0 && (
        <div className="alert error">
          <span>{failed.join(", ")} {failed.length === 1 ? "has" : "have"} not passed the database cross-check.</span>
          <Link to="/admin/check">See the database check →</Link>
        </div>
      )}

      {section === "loading" && (
        <>
          <PipelineDiagram batches={batches} latest={latest} />
          <ImportsTable batches={batches} selected={batch.import_batch_id} onSelect={setSelected} />
          <div className="card">
            <div className="split">
              <ReasonBars
                title={`Why rows were rejected in ${batch.month}`}
                explain="Rejected rows can't be trusted at all, so they are kept aside with their reason and never counted."
                reasons={batch.rejects} base={batch.rows_rejected} tone="rejected" />
              <ReasonBars
                title={`Warnings on kept trips in ${batch.month}`}
                explain="The trip happened, but one value looks wrong. Share is of all kept trips; one trip can have several warnings."
                reasons={batch.warnings} base={batch.rows_accepted} tone="warned" />
            </div>
          </div>
          <RejectedRows key={batch.import_batch_id} batch={batch} />
        </>
      )}

      {section === "check" && <Reconciliation batches={batches} runs={runs} latest={latest} />}
      {section === "benchmarks" && <Benchmarks run={bench} />}
    </section>
  );
}
