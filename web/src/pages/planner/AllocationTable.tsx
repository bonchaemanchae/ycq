import { useEffect } from "react";
import { METRICS, type Row, type Settings } from "./types";

export type TableRow = Row & { final: number; added: boolean };

type Props = {
  rows: TableRow[];
  candidates: Row[];          // eligible zones for this hour that aren't in the table
  weights: Settings;          // the weights the preview was scored with
  focusId: number | null;
  onSet: (row: Row, taxis: number) => void;
  onAdd: (row: Row) => void;
  onRemove: (row: Row) => void;
};

const money = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);

// Why a zone scored what it did: each metric's percentile times its weight.
function ScoreBar({ row, weights }: { row: Row; weights: Settings }) {
  const parts = METRICS.map((m) => ({ ...m, value: weights[m.weight] * row[m.pct] }));
  const title = parts.map((p) =>
    `${p.label}: top ${Math.round((1 - row[p.pct]) * 100)}% · ${row[p.pct].toFixed(2)} × ${weights[p.weight]}`).join("\n");
  return (
    <div className="score" title={title}>
      <div className="score-bar">
        {parts.map((p) => <span key={p.label} style={{ width: `${p.value * 100}%`, background: p.color }} />)}
      </div>
      <span className="score-num">{row.score.toFixed(3)}</span>
    </div>
  );
}

// One hour of the plan: the analyst sets the final taxis for each zone.
export default function AllocationTable({ rows, candidates, weights, focusId, onSet, onAdd, onRemove }: Props) {
  useEffect(() => {
    if (focusId !== null) document.getElementById(`zone-row-${focusId}`)?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  return (
    <div>
      <div className="table-wrap">
        <table className="alloc">
          <thead>
            <tr>
              <th>#</th>
              <th>Zone</th>
              <th>Score</th>
              <th className="num" title="Average pickups in this hour, and pickups minus drop-offs">Pickups / net</th>
              <th className="num">Median fare</th>
              <th className="num">Taxis</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.location_id} id={`zone-row-${r.location_id}`}
                  className={`${r.location_id === focusId ? "focus" : ""} ${r.final !== r.proposed_taxis ? "edited" : ""}`}>
                <td className="muted">{r.rank}</td>
                <td title={`${r.reason} (${r.sample_size.toLocaleString()} pickups in total)`}>
                  <div className="zone-name">{r.zone_name}</div>
                  <div className="muted small">
                    {r.borough} · {r.days} days
                    {r.added && <span className="tag">added</span>}
                  </div>
                </td>
                <td><ScoreBar row={r} weights={weights} /></td>
                <td className="num">
                  <div>{r.avg_pickups}</div>
                  <div className={`small ${r.avg_imbalance > 0 ? "pos" : r.avg_imbalance < 0 ? "neg" : "muted"}`}>
                    {r.avg_imbalance > 0 ? "+" : ""}{r.avg_imbalance} net
                  </div>
                </td>
                <td className="num">{money(r.median_fare)}</td>
                <td className="num">
                  <div className="stepper">
                    <button onClick={() => onSet(r, Math.max(0, r.final - 1))} disabled={r.final === 0}
                            aria-label="One fewer">−</button>
                    <input type="number" min={0} value={r.final}
                           onChange={(e) => onSet(r, Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                    <button onClick={() => onSet(r, r.final + 1)} aria-label="One more">+</button>
                    {r.added && (
                      <button className="link danger-text" onClick={() => onRemove(r)} title="Remove this zone">✕</button>
                    )}
                  </div>
                  {r.final !== r.proposed_taxis && <div className="muted small">proposed {r.proposed_taxis}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="add-zone">
        <select value="" onChange={(e) => {
          const row = candidates.find((c) => c.location_id === Number(e.target.value));
          if (row) onAdd(row);
        }} disabled={candidates.length === 0}>
          <option value="">
            {candidates.length ? `+ Add another eligible zone (${candidates.length})` : "No other eligible zones"}
          </option>
          {candidates.map((c) => (
            <option key={c.location_id} value={c.location_id}>
              #{c.rank} {c.zone_name} ({c.borough}) · score {c.score.toFixed(3)}
            </option>
          ))}
        </select>
        <span className="muted small">or click a zone on the map</span>
      </div>
    </div>
  );
}
