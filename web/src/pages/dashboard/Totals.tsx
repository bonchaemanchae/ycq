import { count, miles, minutes, money, type Totals } from "./types";

// The headline numbers for the current filters: demand, supply, and what a trip is worth.
export default function TotalsRow({ totals: t }: { totals: Totals }) {
  const tiles = [
    { label: "Pickups", value: count(t.pickups), note: t.pickupsPerDay === null ? "" : `${count(Math.round(t.pickupsPerDay))} a day over ${count(t.days)} days` },
    { label: "Drop-offs", value: count(t.dropoffs), note: `in ${count(t.zones)} zones` },
    { label: "Average fare", value: money(t.averageFare), note: "metered trips" },
    { label: "Average trip", value: minutes(t.averageDurationSec), note: t.averageDistance === null ? "" : `${miles(t.averageDistance)}` },
  ];
  return (
    <div className="dash-tiles">
      {tiles.map((x) => (
        <div key={x.label} className="card dash-tile">
          <div className="dash-tile-label">{x.label}</div>
          <div className="dash-tile-value">{x.value}</div>
          {x.note && <div className="muted small">{x.note}</div>}
        </div>
      ))}
    </div>
  );
}
