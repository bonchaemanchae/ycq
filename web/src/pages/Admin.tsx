import { useEffect, useState } from "react";
import { api } from "../api";
import Benchmarks from "./admin/Benchmarks";
import ImportsTable from "./admin/ImportsTable";
import MonthBars from "./admin/MonthBars";
import PipelineDiagram from "./admin/PipelineDiagram";
import ReasonBars from "./admin/ReasonBars";
import Reconciliation from "./admin/Reconciliation";
import RejectedRows from "./admin/RejectedRows";
import SectionNav, { type Section } from "./admin/SectionNav";
import { latestRuns, n, type BenchmarkRun, type ImportBatch, type ReconRun } from "./admin/types";
import "./admin/admin.css";

const SECTIONS: Section[] = [
  { id: "overview", label: "Overview" },
  { id: "months", label: "Months" },
  { id: "reasons", label: "Reasons" },
  { id: "agreement", label: "Database check" },
  { id: "benchmarks", label: "Benchmarks" },
  { id: "rejected", label: "Rejected rows" },
  { id: "files", label: "Imported files" },
];

// Administration, admin role only. Backend routes are in
// api/routers/admin.py. The page answers three questions, top to bottom:
// did the data load, what was removed or flagged and why, and do both
// databases still agree, and which database answers the app's questions faster.
export default function Admin() {
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
    <div className="page-head">
      <h1>Administration</h1>
      <p className="muted">
        Did the taxi data load correctly, what was removed or flagged and why, and do both databases still agree?
      </p>
    </div>
  );
  if (error) return <section>{head}<div className="alert error">{error}</div></section>;
  if (!batches || !runs || !bench) return <section>{head}<p className="muted">Loading…</p></section>;
  if (batches.length === 0) return <section>{head}<p className="muted">No data has been imported yet.</p></section>;

  const latest = latestRuns(runs);
  const failed = batches.filter((b) => latest.get(b.month)?.passed !== true).map((b) => b.month);
  const batch = batches.find((b) => b.import_batch_id === selected) ?? batches[batches.length - 1];
  const months = batches.map((b) => b.month);

  return (
    <section className="admin">
      {head}
      <SectionNav sections={SECTIONS} />

      <div id="overview" className="anchor">
        <div className={`banner ${failed.length ? "bad" : "ok"}`} role="status">
          <span className="banner-icon" aria-hidden="true">{failed.length ? "!" : "✓"}</span>
          <div>
            <strong>
              {failed.length
                ? `Needs attention: ${failed.join(", ")} ${failed.length === 1 ? "has" : "have"} not passed the database cross-check`
                : `All good: ${months.length} ${months.length === 1 ? "month" : "months"} loaded and both databases agree`}
            </strong>
            <span className="muted"> · {months[0]}{months.length > 1 ? ` to ${months[months.length - 1]}` : ""},{" "}
              {n(batches.reduce((s, b) => s + b.rows_accepted, 0))} trips available for analysis</span>
          </div>
        </div>

        <PipelineDiagram batches={batches} latest={latest} />
      </div>

      <div id="months" className="anchor">
        <MonthBars batches={batches} selected={batch.import_batch_id} onSelect={setSelected} />
      </div>

      <div id="reasons" className="anchor card">
        <div className="split">
          <ReasonBars
            title={`Why rows were rejected · ${batch.month}`}
            explain="Rejected rows can't be trusted at all, so they are kept aside with their reason and never counted."
            reasons={batch.rejects} base={batch.rows_rejected} tone="rejected" />
          <ReasonBars
            title={`Warnings on kept trips · ${batch.month}`}
            explain="The trip happened, but one value looks wrong. Share is of all kept trips; one trip can have several warnings."
            reasons={batch.warnings} base={batch.rows_accepted} tone="warned" />
        </div>
      </div>

      <div id="agreement" className="anchor">
        <Reconciliation batches={batches} runs={runs} latest={latest} />
      </div>
      <div id="benchmarks" className="anchor">
        <Benchmarks run={bench} />
      </div>
      <div id="rejected" className="anchor">
        <RejectedRows key={batch.import_batch_id} batch={batch} />
      </div>
      <div id="files" className="anchor">
        <ImportsTable batches={batches} />
      </div>
    </section>
  );
}
