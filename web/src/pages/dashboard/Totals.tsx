import { count, minutes, type Filters, type Totals } from "./types";

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

// Hours of the day the filters keep (22 to 2 wraps past midnight), or null for all 24.
function filteredHours(f: Filters): number | null {
  if (f.hourFrom === null && f.hourTo === null) return null;
  const from = f.hourFrom ?? 0, to = f.hourTo ?? 23;
  return from <= to ? to - from + 1 : 24 - from + to + 1;
}

// The headline numbers, first thing on the page. Each shows the number that
// stays comparable whatever is filtered (per day, or per hour when an hour
// range is chosen, the unit the planner allocates in) and one fact under it.
export default function TotalsRow({ totals: t, filters }: { totals: Totals; filters: Filters }) {
  const hours = filteredHours(filters);
  const days = t.days || 0;
  const per = hours ? days * hours : days;          // matching days, or matching hours
  const unit = hours ? "an hour" : "a day";
  const rate = (n: number) => (per ? Math.round(n / per) : 0);

  const pickups = rate(t.pickups);
  const balance = rate(t.pickups - t.dropoffs);     // > 0: taxis leave faster than they arrive
  // within 2% of pickups counts as balanced: across the whole city the gap is
  // mostly trips that end outside the mapped zones, not a real shortage
  const even = Math.abs(t.pickups - t.dropoffs) <= 0.02 * t.pickups;
  const side = even ? "" : balance > 0 ? "short" : "surplus";
  const perTaxiHour = t.averageFare !== null && t.averageDurationSec
    ? t.averageFare / (t.averageDurationSec / 3600) : null;

  const tiles = [
    {
      label: "Pickups", icon: icon("M12 19V5M5 12l7-7 7 7"),
      value: <>{count(pickups)} <span className="dash-tile-unit">{unit}</span></>,
      note: hours
        ? `${count(days ? Math.round(t.pickups / days) : 0)} a day · ${count(t.pickups)} over ${count(days)} days`
        : `${count(t.pickups)} over ${count(days)} days`,
    },
    {
      label: "Taxi balance", icon: icon("M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"),
      // no sign to decode: how many taxis short or extra, and which way, in words
      value: side ? (
        <span className={side}>{count(Math.abs(balance))} {side === "short" ? "short" : "extra"}</span>
      ) : "Balanced",
      note: side === "short" ? `Each ${hours ? "hour" : "day"}, more taxis leave than arrive`
        : side === "surplus" ? `Each ${hours ? "hour" : "day"}, more taxis arrive than leave`
        : "About as many arrive as leave (within 2%)",
    },
    {
      label: "Average fare", icon: icon("M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"),
      value: t.averageFare === null ? "n/a" : `$${t.averageFare.toFixed(2)}`,
      note: perTaxiHour === null ? "" : `≈ $${Math.round(perTaxiHour)} per taxi-hour`,
    },
    {
      label: "Average trip", icon: icon("M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"),
      value: minutes(t.averageDurationSec),
      note: t.averageDistance === null ? "" : `${t.averageDistance.toFixed(1)} miles per trip`,
    },
  ];
  return (
    <div className="dash-tiles">
      {tiles.map((x) => (
        <div key={x.label} className="card dash-tile">
          <div className="dash-tile-head">
            <span className="dash-tile-icon">{x.icon}</span>
            <span className="dash-tile-label">{x.label}</span>
          </div>
          <div className="dash-tile-value">{x.value}</div>
          {x.note && <div className="dash-tile-note">{x.note}</div>}
        </div>
      ))}
    </div>
  );
}
