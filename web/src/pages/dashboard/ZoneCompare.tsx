import { count, hourLabel, miles, minutes, money, signed, type Compare, type CompareZone } from "./types";

type Props = {
  compare: Compare | null;
  loading: boolean;
  error: string;
  onRemove: (zoneId: number) => void;
};

type Row = { label: string; value: (z: CompareZone) => string; help?: string };

const ROWS: Row[] = [
  { label: "Borough", value: (z) => z.borough ?? "" },
  { label: "Pickups", value: (z) => count(z.pickups) },
  { label: "Drop-offs", value: (z) => count(z.dropoffs) },
  { label: "Imbalance", value: (z) => signed(z.imbalance ?? 0) },
  { label: "Pickups per hour, average", value: (z) => count(z.meanPickupsPerHour) },
  { label: "Pickups per hour, median", value: (z) => count(z.medianPickupsPerHour),
    help: "Half of the hours had fewer pickups than this" },
  { label: "Pickups per hour, 90th percentile", value: (z) => count(z.p90PickupsPerHour),
    help: "Only one hour in ten was busier than this" },
  { label: "Busiest single hour", value: (z) => count(z.maxPickupsPerHour) },
  { label: "Peak hour of the day", value: (z) =>
      z.peakHour === null || z.peakHour === undefined ? "n/a"
        : `${hourLabel(z.peakHour)} (${count(z.peakHourAveragePickups)} on average)` },
  { label: "Average fare", value: (z) => money(z.averageFare) },
  { label: "Average distance", value: (z) => miles(z.averageDistance) },
  { label: "Average duration", value: (z) => minutes(z.averageDurationSec) },
];

// Up to three zones side by side, for the same filters as the rest of the page.
export default function ZoneCompare({ compare, loading, error, onRemove }: Props) {
  if (error) return <div className="alert error"><span>{error}</span></div>;
  if (!compare) return loading ? <p className="muted">Loading…</p> : null;
  return (
    <div className={loading ? "dash-stale" : ""}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              {compare.zones.map((z) => (
                <th key={z.zoneId} className="num">
                  {z.zoneName} <button className="link" title="Remove" onClick={() => onRemove(z.zoneId)}>×</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label}>
                <td title={r.help}>{r.label}{r.help && <span className="muted"> ⓘ</span>}</td>
                {compare.zones.map((z) => (
                  <td key={z.zoneId} className="num">{z.found ? r.value(z) : <span className="muted">no matching hours</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small dash-note">
        Hourly figures count every matching hour, including hours with no trips. MongoDB works out the median and
        percentile with its approximate method, so they can differ slightly from an exact calculation.
      </p>
    </div>
  );
}
