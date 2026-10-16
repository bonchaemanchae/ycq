import { n, pct, type ImportBatch } from "./types";

// One 100% bar per month: clean trips, trips kept with a warning, and rows
// rejected. Clicking a month selects it for the sections below.
export default function MonthBars({ batches, selected, onSelect }: {
  batches: ImportBatch[]; selected: number | null; onSelect: (id: number) => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Each month at a glance</div>
        <div className="legend" aria-hidden="true">
          <span><i className="swatch clean" />Clean</span>
          <span><i className="swatch warned" />Kept, with a warning</span>
          <span><i className="swatch rejected" />Rejected</span>
        </div>
      </div>
      <p className="muted small">
        Pick a month to see why its rows were rejected or flagged. Warned trips are real and still counted;
        they are only left out of the averages a suspicious value would distort.
      </p>
      <div className="month-bars">
        {batches.map((b) => {
          const clean = b.rows_accepted - b.rows_warned;
          const parts = [
            { cls: "clean", label: "Clean", rows: clean },
            { cls: "warned", label: "Kept, with a warning", rows: b.rows_warned },
            { cls: "rejected", label: "Rejected", rows: b.rows_rejected },
          ];
          return (
            <button key={b.import_batch_id} type="button"
                    className={`month-row ${b.import_batch_id === selected ? "selected" : ""}`}
                    aria-pressed={b.import_batch_id === selected}
                    onClick={() => onSelect(b.import_batch_id)}>
              <span className="month-label">{b.month}</span>
              <span className="stack" role="img"
                    aria-label={parts.map((p) => `${p.label} ${n(p.rows)}`).join(", ")}>
                {parts.map((p) => p.rows > 0 && (
                  <span key={p.cls} className={`seg ${p.cls}`}
                        style={{ flexGrow: p.rows }}
                        title={`${p.label}: ${n(p.rows)} (${pct(p.rows, b.rows_read)})`} />
                ))}
              </span>
              <span className="month-figures">
                <strong>{n(b.rows_read)}</strong> rows
                <span className="muted"> · {pct(b.rows_warned, b.rows_read)} warned · {pct(b.rows_rejected, b.rows_read)} rejected</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
