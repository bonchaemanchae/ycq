import { count, signed, type ZoneRow } from "./types";

const N = 5;

// The zones that lose the most taxis (more pickups than drop-offs) and the
// ones that gain the most.
export default function Imbalances({ zones }: { zones: ZoneRow[] }) {
  const byImbalance = [...zones].sort((a, b) => b.imbalance - a.imbalance || a.zoneId - b.zoneId);
  const outflow = byImbalance.filter((z) => z.imbalance > 0).slice(0, N);
  const inflow = byImbalance.filter((z) => z.imbalance < 0).reverse().slice(0, N);

  const list = (rows: ZoneRow[], empty: string) =>
    rows.length === 0 ? <p className="muted small">{empty}</p> : (
      <table>
        <tbody>
          {rows.map((z) => (
            <tr key={z.zoneId}>
              <td>{z.zoneName} <span className="muted small">{z.borough}</span></td>
              <td className={`num ${z.imbalance > 0 ? "pos" : "neg"}`}>{signed(z.imbalance)}</td>
              <td className="num muted small">{count(z.pickups)} / {count(z.dropoffs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <div className="dash-imbalance">
      <div>
        <div className="dash-subtitle">Most taxis leaving</div>
        <p className="muted small">More pickups than drop-offs: taxis are needed here.</p>
        {list(outflow, "No zone has more pickups than drop-offs.")}
      </div>
      <div>
        <div className="dash-subtitle">Most taxis arriving</div>
        <p className="muted small">More drop-offs than pickups: taxis end up here empty.</p>
        {list(inflow, "No zone has more drop-offs than pickups.")}
      </div>
    </div>
  );
}
