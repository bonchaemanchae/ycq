import { PLAIN, n, pct, type Reason } from "./types";

// Horizontal bars of how many rows each rule caught, largest first. Bars are
// scaled to the largest reason; the exact count and share sit beside each.
export default function ReasonBars({ title, explain, reasons, base, tone }: {
  title: string; explain: string; reasons: Reason[]; base: number; tone: "rejected" | "warned";
}) {
  const max = Math.max(1, ...reasons.map((r) => r.rows));
  return (
    <div>
      <div className="card-title">{title}</div>
      <p className="muted small">{explain}</p>
      {reasons.length === 0 ? <p className="muted">None.</p> : (
        <ul className="reason-bars">
          {reasons.map((r) => (
            <li key={r.code} title={`${r.code}: ${r.description}`}>
              <span className="reason-label">
                <span className="code-chip">{r.code}</span>{PLAIN[r.code] ?? r.description}
              </span>
              <span className="reason-track">
                <span className={`reason-fill ${tone}`} style={{ width: `${(100 * r.rows) / max}%` }} />
              </span>
              <span className="reason-count">{n(r.rows)}</span>
              <span className="reason-share muted">{pct(r.rows, base)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
