import { hourLabel, whyLine, type Row, type Settings } from "./types";
import type { TableRow } from "./AllocationTable";

type Props = {
  watched: number[];            // zones the analyst looked at on the dashboard
  names: Map<number, string>;
  hour: number;
  rows: TableRow[];             // zones in the plan this hour
  candidates: Row[];            // eligible zones not in the plan this hour
  weights: Settings;
  onFocus: (zoneId: number) => void;
  onAdd: (row: Row) => void;
};

// For each zone brought over from the dashboard: how many taxis the plan gives
// it this hour, or why it has none, with one click to add it when it can be.
export default function WatchedZones({ watched, names, hour, rows, candidates, weights, onFocus, onAdd }: Props) {
  if (watched.length === 0) return null;
  return (
    <div className="watched">
      <span className="watched-title">From the dashboard</span>
      {watched.map((id) => {
        const name = names.get(id) ?? `Zone ${id}`;
        const row = rows.find((r) => r.location_id === id);
        const candidate = candidates.find((r) => r.location_id === id);
        return (
          <div key={id} className={`watched-item ${row && row.final > 0 ? "in" : "out"}`}>
            <button className="link watched-name" onClick={() => onFocus(id)}>{name}</button>
            {row ? (
              <span>
                <strong>{row.final} {row.final === 1 ? "taxi" : "taxis"}</strong> at {hourLabel(hour)}
                <span className="muted small"> · {whyLine(row, weights)}</span>
              </span>
            ) : candidate ? (
              <span>
                not in the proposal (ranked #{candidate.rank}){" "}
                <button className="watched-add" onClick={() => onAdd(candidate)}>Add</button>
              </span>
            ) : (
              <span className="muted">
                not eligible at {hourLabel(hour)}: outside the chosen boroughs, or fewer than {weights.min_sample} pickups
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
