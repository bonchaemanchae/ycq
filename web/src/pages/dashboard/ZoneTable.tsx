import { useMemo, useState } from "react";
import { count, miles, minutes, money, percent, signed, type Metric, type ZoneRow } from "./types";

type Props = {
  zones: ZoneRow[];
  metric: Metric;
  selected: number[];
  onToggle: (zoneId: number) => void;
};

const SHOWN = 15;

// Every matching zone, ranked by the metric the map shows. Ticking a zone adds
// it to the comparison (up to three).
export default function ZoneTable({ zones, metric, selected, onToggle }: Props) {
  const [all, setAll] = useState(false);
  const ranked = useMemo(
    () => [...zones].sort((a, b) => b[metric] - a[metric] || a.zoneId - b.zoneId),
    [zones, metric]);
  const rows = all ? ranked : ranked.slice(0, SHOWN);

  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th>#</th>
              <th>Zone</th>
              <th>Borough</th>
              <th className="num">Pickups</th>
              <th className="num">Share</th>
              <th className="num">Drop-offs</th>
              <th className="num">Imbalance</th>
              <th className="num">Avg fare</th>
              <th className="num">Avg distance</th>
              <th className="num">Avg duration</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((z, i) => (
              <tr key={z.zoneId}>
                <td>
                  <input type="checkbox" checked={selected.includes(z.zoneId)}
                         disabled={!selected.includes(z.zoneId) && selected.length >= 3}
                         title="Compare this zone" onChange={() => onToggle(z.zoneId)} />
                </td>
                <td className="muted">{i + 1}</td>
                <td>{z.zoneName}</td>
                <td>{z.borough}</td>
                <td className="num">{count(z.pickups)}</td>
                <td className="num">{percent(z.pickupShare)}</td>
                <td className="num">{count(z.dropoffs)}</td>
                <td className={`num ${z.imbalance > 0 ? "pos" : z.imbalance < 0 ? "neg" : ""}`}>{signed(z.imbalance)}</td>
                <td className={`num ${z.averageFare === null ? "muted" : ""}`}>{money(z.averageFare)}</td>
                <td className={`num ${z.averageDistance === null ? "muted" : ""}`}>{miles(z.averageDistance)}</td>
                <td className={`num ${z.averageDurationSec === null ? "muted" : ""}`}>{minutes(z.averageDurationSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ranked.length > SHOWN && (
        <button className="link" onClick={() => setAll(!all)}>
          {all ? `Show the top ${SHOWN}` : `Show all ${ranked.length} zones`}
        </button>
      )}
      <p className="muted small dash-note">
        Share is out of all pickups matching the filters. n/a = no trips to average. Imbalance is pickups minus
        drop-offs: positive means more taxis leave the zone with a passenger than arrive with one.
      </p>
    </div>
  );
}
