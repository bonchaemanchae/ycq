import { n, pct, when, type ImportBatch } from "./types";

// One row per imported file: how its rows split into clean, kept with a
// warning, and rejected, with the counts and the file's record. Clicking a
// month selects it for the reasons and rejected rows below.
export default function ImportsTable({ batches, selected, onSelect }: {
  batches: ImportBatch[]; selected: number | null; onSelect: (id: number) => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          Imports <div className="card-sub">Pick a month to see why its rows were rejected or flagged.</div>
        </div>
        <div className="legend" aria-hidden="true">
          <span><i className="swatch clean" />Clean</span>
          <span><i className="swatch warned" />Kept, with a warning</span>
          <span><i className="swatch rejected" />Rejected</span>
        </div>
      </div>
      <div className="table-wrap">
        <table className="imports">
          <thead>
            <tr>
              <th>Month</th><th className="bar-col">Rows</th>
              <th className="num">Read</th><th className="num">Kept</th>
              <th className="num">Warned</th><th className="num">Rejected</th>
              <th>File</th><th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => {
              const clean = b.rows_accepted - b.rows_warned;
              const parts = [
                { cls: "clean", label: "Clean", rows: clean },
                { cls: "warned", label: "Kept, with a warning", rows: b.rows_warned },
                { cls: "rejected", label: "Rejected", rows: b.rows_rejected },
              ];
              const on = b.import_batch_id === selected;
              return (
                <tr key={b.import_batch_id} className={`pickable ${on ? "selected" : ""}`}
                    onClick={() => onSelect(b.import_batch_id)} aria-selected={on}>
                  <td><button className="link month-pick" onClick={() => onSelect(b.import_batch_id)}>{b.month}</button></td>
                  <td className="bar-col">
                    <span className="stack" role="img" aria-label={parts.map((p) => `${p.label} ${n(p.rows)}`).join(", ")}>
                      {parts.map((p) => p.rows > 0 && (
                        <span key={p.cls} className={`seg ${p.cls}`} style={{ flexGrow: p.rows }}
                              title={`${p.label}: ${n(p.rows)} (${pct(p.rows, b.rows_read)})`} />
                      ))}
                    </span>
                  </td>
                  <td className="num">{n(b.rows_read)}</td>
                  <td className="num">{n(b.rows_accepted)}</td>
                  <td className="num">{n(b.rows_warned)} <span className="muted small">{pct(b.rows_warned, b.rows_read)}</span></td>
                  <td className="num">{n(b.rows_rejected)} <span className="muted small">{pct(b.rows_rejected, b.rows_read)}</span></td>
                  <td>
                    <div>{b.source_file}</div>
                    <div className="muted small" title="SHA-256 checksum, checked against the pinned value">
                      SHA-256 <code>{b.checksum_prefix}…</code>, {b.status}
                    </div>
                  </td>
                  <td className="small">{when(b.finished_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Warned trips are real and still counted; they are only left out of the averages a suspicious value would distort.
      </p>
    </div>
  );
}
