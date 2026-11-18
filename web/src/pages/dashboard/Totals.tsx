import { useState } from "react";
import { count, miles, minutes, money, type Totals } from "./types";

// The headline numbers for the current filters. Three show; fare, distance
// and duration open with "More numbers".
export default function TotalsRow({ totals: t }: { totals: Totals }) {
  const tiles = [
    { label: "Pickups", value: count(t.pickups), note: t.pickupsPerDay === null ? "" : `${count(t.pickupsPerDay)} a day` },
    { label: "Drop-offs", value: count(t.dropoffs), note: `in ${count(t.zones)} zones` },
    { label: "Days", value: count(t.days), note: "with matching hours" },
    { label: "Average fare", value: money(t.averageFare), note: "metered trips only" },
    { label: "Average distance", value: miles(t.averageDistance), note: "" },
    { label: "Average duration", value: minutes(t.averageDurationSec), note: "" },
  ];
  const [more, setMore] = useState(false);
  return (
    <div className="dash-tiles">
      {tiles.slice(0, more ? tiles.length : 3).map((x) => (
        <div key={x.label} className="card dash-tile">
          <div className="dash-tile-label">{x.label}</div>
          <div className="dash-tile-value">{x.value}</div>
          {x.note && <div className="muted small">{x.note}</div>}
        </div>
      ))}
      <button className="link dash-more" onClick={() => setMore((m) => !m)} aria-expanded={more}>
        {more ? "Fewer numbers" : "More numbers"}
      </button>
    </div>
  );
}
