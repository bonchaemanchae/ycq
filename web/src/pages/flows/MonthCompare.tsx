import { count, monthLabel, percent, type Compare, type MonthEntry, type MonthHeader } from "./types";

type Props = {
  compare: Compare | null;
  loading: boolean;
  error: string;
  originZoneId: number;
  onClose: () => void;
};

// What one cell says. A zone missing from a month's list really had no trips
// when that list is complete (it holds every destination), or when the month
// has no trips from this zone at all; otherwise it may have had a few.
function Cell({ entry, month }: { entry: MonthEntry | null; month: MonthHeader }) {
  if (entry) {
    return <>#{entry.rank} · {count(entry.trips)} <span className="muted">({percent(entry.share)})</span></>;
  }
  if (!month.found || month.complete) return <>0</>;
  return <span className="muted">not in top 10</span>;
}

// The same origin, day type and time of day side by side across every loaded month.
export default function MonthCompare({ compare, loading, error, originZoneId, onClose }: Props) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          Compare months <span className="muted">· built from {compare?.basis ?? "each month's top 10 only"}</span>
        </div>
        <button className="link" onClick={onClose} aria-label="Close comparison">✕</button>
      </div>

      {error && <div className="alert error"><span>{error}</span></div>}
      {!compare ? (loading && <p className="muted">Loading…</p>) : compare.destinations.length === 0 ? (
        <p className="muted">No trips from this zone at this time of day in any loaded month.</p>
      ) : (
        <div className={`table-wrap ${loading ? "flows-stale" : ""}`}>
          <table>
            <thead>
              <tr>
                <th>Destination</th>
                {compare.months.map((m) => (
                  <th key={m.month} className="num">
                    {monthLabel(m.month)}
                    <div className="muted small flows-month-total">
                      {m.found ? `${count(m.totalTrips ?? 0)} trips` : "no trips"}
                    </div>
                  </th>
                ))}
                <th className="num">Months in top 10</th>
              </tr>
            </thead>
            <tbody>
              {compare.destinations.map((d) => (
                <tr key={d.zoneId}>
                  <td>
                    {d.zoneName} <span className="muted small">{d.borough}</span>
                    {d.zoneId === originZoneId && <span className="tag">within zone</span>}
                  </td>
                  {compare.months.map((m) => (
                    <td key={m.month} className="num"><Cell entry={d.byMonth[m.month]} month={m} /></td>
                  ))}
                  <td className="num">{d.monthsInTop10} / {compare.months.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small flows-note">
        Each month only stores its top 10 destinations, so this table is built from those lists.
        “0” means no trips from this origin to that destination that month; “not in top 10” means there may
        have been a few.
      </p>
    </div>
  );
}
