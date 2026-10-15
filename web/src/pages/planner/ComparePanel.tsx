import { DAYS, hourLabel, type Change, type VersionSummary } from "./types";

type Props = {
  from: VersionSummary;
  to: VersionSummary;
  changes: Change[];
  onClose: () => void;
};

const describe = (v: VersionSummary) =>
  `${DAYS[v.iso_dow - 1].slice(0, 3)} ${hourLabel(v.start_hour)}–${hourLabel(v.end_hour)} · fleet ${v.fleet_size}`;

// What changed between two saved versions, zone by zone and hour by hour.
export default function ComparePanel({ from, to, changes, onClose }: Props) {
  const added = changes.filter((c) => c.taxis_before === 0).length;
  const dropped = changes.filter((c) => c.taxis_after === 0).length;
  const moved = changes.reduce((n, c) => n + Math.max(0, c.change), 0);

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Compare v{from.version_no} → v{to.version_no}</div>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <div className="compare-summary">
        <div><span className="muted small">v{from.version_no}</span><div>{describe(from)}</div></div>
        <div className="arrow">→</div>
        <div><span className="muted small">v{to.version_no}</span><div>{describe(to)}</div></div>
      </div>

      {changes.length === 0 ? (
        <p className="muted">The two versions place every taxi in the same zones.</p>
      ) : (
        <>
          <div className="kpis small-kpis">
            <div className="kpi"><span>{changes.length}</span>zone-hours changed</div>
            <div className="kpi"><span>{moved}</span>taxis gained</div>
            <div className="kpi"><span>{added}</span>zones added</div>
            <div className="kpi"><span>{dropped}</span>zones dropped</div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Hour</th><th>Zone</th>
                  <th className="num">v{from.version_no}</th><th className="num">v{to.version_no}</th>
                  <th className="num">Change</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={`${c.hour}:${c.location_id}`}>
                    <td>{hourLabel(c.hour)}</td>
                    <td>{c.zone_name} <span className="muted small">{c.borough}</span></td>
                    <td className="num">{c.taxis_before}</td>
                    <td className="num">{c.taxis_after}</td>
                    <td className={`num ${c.change > 0 ? "pos" : "neg"}`}>{c.change > 0 ? "+" : ""}{c.change}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
