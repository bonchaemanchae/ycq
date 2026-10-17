import { useMemo } from "react";
import { DAY_TYPES, TIME_BUCKETS, monthLabel, type Query, type Zone } from "./types";

type Props = {
  query: Query;
  onChange: (q: Query) => void;
  zones: Zone[];
  months: string[];
};

// Origin zone, month, weekday/weekend and time of day. The origin can also be
// picked by clicking the map.
export default function FlowControls({ query: q, onChange, zones, months }: Props) {
  const set = <K extends keyof Query>(k: K, v: Query[K]) => onChange({ ...q, [k]: v });

  const byBorough = useMemo(() => {
    const groups: Record<string, Zone[]> = {};
    for (const z of zones) {
      if (!groups[z.borough]) groups[z.borough] = [];
      groups[z.borough].push(z);
    }
    for (const list of Object.values(groups)) list.sort((a, b) => a.zone_name.localeCompare(b.zone_name));
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [zones]);

  return (
    <div className="card flows-controls">
      <label className="flows-field">
        <span>Origin zone</span>
        <select value={q.originZoneId} onChange={(e) => set("originZoneId", Number(e.target.value))}>
          {byBorough.map(([borough, list]) => (
            <optgroup key={borough} label={borough}>
              {list.map((z) => <option key={z.location_id} value={z.location_id}>{z.zone_name} ({z.location_id})</option>)}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="flows-field">
        <span>Month</span>
        <select value={q.month} onChange={(e) => set("month", e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </label>

      <fieldset className="flows-field">
        <legend>Day type</legend>
        <div className="flows-radios">
          {DAY_TYPES.map((d) => (
            <label key={d.value} className={q.dayType === d.value ? "on" : ""}>
              <input type="radio" name="dayType" value={d.value} checked={q.dayType === d.value}
                     onChange={() => set("dayType", d.value)} />
              {d.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flows-field">
        <legend>Time of day (pickup)</legend>
        <div className="flows-radios">
          {TIME_BUCKETS.map((b) => (
            <label key={b.value} className={q.timeBucket === b.value ? "on" : ""}>
              <input type="radio" name="timeBucket" value={b.value} checked={q.timeBucket === b.value}
                     onChange={() => set("timeBucket", b.value)} />
              {b.label} <span className="muted small">{b.hours}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
