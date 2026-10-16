import { n, when, type ImportBatch, type ReconRun } from "./types";

type Pair = { label: string; pg: number | null; mongo: number | null };

function Check({ pair }: { pair: Pair }) {
  const same = pair.pg != null && pair.pg === pair.mongo;
  return (
    <div className={`check ${same ? "ok" : "bad"}`}>
      <span className="check-label">{pair.label}</span>
      <span className="check-values">
        <span><small>PostgreSQL</small>{n(pair.pg)}</span>
        <span className="check-mark" aria-label={same ? "match" : "differ"}>{same ? "=" : "≠"}</span>
        <span><small>MongoDB</small>{n(pair.mongo)}</span>
      </span>
    </div>
  );
}

// Do the two databases agree? One panel per month from its latest run, then
// every run in a collapsible table.
export default function Reconciliation({ batches, runs, latest }: {
  batches: ImportBatch[]; runs: ReconRun[]; latest: Map<string, ReconRun>;
}) {
  return (
    <div className="card">
      <div className="card-title">Do both databases agree?</div>
      <p className="muted small">
        After every load, MongoDB's summaries are compared with PostgreSQL, hour by hour and zone by zone.
        A month passes only if every number matches.
      </p>
      <div className="recon-months">
        {batches.map((b) => {
          const r = latest.get(b.month);
          const status = r?.passed ? "passed" : r?.passed === false ? "failed" : "not checked";
          return (
            <div key={b.month} className={`recon-month ${r?.passed ? "ok" : "bad"}`}>
              <div className="recon-head">
                <strong>{b.month}</strong>
                <span className={`status-pill ${r?.passed ? "ok" : "bad"}`}>
                  {r?.passed ? "✓" : "!"} {status}
                </span>
              </div>
              {r ? (
                <>
                  <Check pair={{ label: "Hourly summaries", pg: r.pg_hour_rows, mongo: r.mongo_hour_docs }} />
                  <Check pair={{ label: "Pickups", pg: r.pg_pickups, mongo: r.mongo_pickups }} />
                  <Check pair={{ label: "Drop-offs", pg: r.pg_dropoffs, mongo: r.mongo_dropoffs }} />
                  <p className="muted small recon-foot">
                    {n(r.zone_hour_mismatches)} zone-hour and {n(r.od_mismatches)} destination differences ·
                    checked {when(r.finished_at)}
                  </p>
                </>
              ) : <p className="muted small">No reconciliation run for this month yet.</p>}
            </div>
          );
        })}
      </div>

      <details className="more">
        <summary>All reconciliation runs ({runs.length})</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">Run</th><th>Month</th><th>Result</th>
                <th className="num">Zone-hour diffs</th><th className="num">Destination diffs</th>
                <th>Finished</th><th>Details</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.reconciliation_run_id}>
                  <td className="num">{r.reconciliation_run_id}</td>
                  <td>{r.month}</td>
                  <td>{r.passed ? "passed" : r.passed === false ? "failed" : "unfinished"}</td>
                  <td className="num">{n(r.zone_hour_mismatches)}</td>
                  <td className="num">{n(r.od_mismatches)}</td>
                  <td>{when(r.finished_at)}</td>
                  <td>
                    <details>
                      <summary className="small">show</summary>
                      <pre className="example">{JSON.stringify(r.details, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
