import { n, pct, type ImportBatch, type ReconRun } from "./types";

// How the data got here, as five steps with the live numbers for each.
// Rejected rows branch off after the checks: they are kept with a reason but
// never reach the analysis.
export default function PipelineDiagram({ batches, latest }: {
  batches: ImportBatch[]; latest: Map<string, ReconRun>;
}) {
  const sum = (k: "rows_read" | "rows_accepted" | "rows_rejected") =>
    batches.reduce((s, b) => s + (b[k] ?? 0), 0);
  const read = sum("rows_read");
  const accepted = sum("rows_accepted");
  const rejected = sum("rows_rejected");
  const runs = batches.map((b) => latest.get(b.month));
  const hourlyDocs = runs.every((r) => r?.mongo_hour_docs != null)
    ? runs.reduce((s, r) => s + (r?.mongo_hour_docs ?? 0), 0) : null;
  const passed = runs.filter((r) => r?.passed === true).length;
  const allPassed = batches.length > 0 && passed === batches.length;

  return (
    <div className="card">
      <div className="card-title">How the data got here</div>
      <ol className="pipeline" aria-label="Data pipeline">
        <li className="step">
          <span className="step-no">1</span>
          <span className="step-title">Raw trip files</span>
          <span className="step-value">{n(read)}</span>
          <span className="step-note">rows in {batches.length} monthly {batches.length === 1 ? "file" : "files"} from NYC TLC</span>
        </li>
        <li className="step">
          <span className="step-no">2</span>
          <span className="step-title">Quality checks</span>
          <span className="step-value">{pct(accepted, read)}</span>
          <span className="step-note">of rows passed. Every row is tested against the import rules</span>
          <span className="branch" title="Rejected rows are stored with their reason and left out of all analysis">
            <span className="branch-value">{n(rejected)}</span> rejected ({pct(rejected, read)}), kept aside with a reason
          </span>
        </li>
        <li className="step">
          <span className="step-no">3</span>
          <span className="step-title">Stored in PostgreSQL</span>
          <span className="step-value">{n(accepted)}</span>
          <span className="step-note">trips in the main database, the source of truth</span>
        </li>
        <li className="step">
          <span className="step-no">4</span>
          <span className="step-title">Summarised into MongoDB</span>
          <span className="step-value">{n(hourlyDocs)}</span>
          <span className="step-note">hourly zone summaries for fast maps and charts</span>
        </li>
        <li className={`step ${allPassed ? "step-good" : "step-bad"}`}>
          <span className="step-no">5</span>
          <span className="step-title">Cross-checked</span>
          <span className="step-value">{passed} of {batches.length}</span>
          <span className="step-note">
            {allPassed ? "months match exactly in both databases" : "months match. Check the reconciliation below"}
          </span>
        </li>
      </ol>
    </div>
  );
}
