import { METRICS, WEEKDAYS, hourLabel, type Filters, type Metric } from "./types";

type Props = {
  filters: Filters;
  onChange: (f: Filters) => void;
  boroughs: string[];
  bounds: { dateFrom: string; dateTo: string } | null;   // the loaded date range
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Date range, weekdays, hours of the day, boroughs and what to colour the map
// by. Every change reloads the page's numbers.
export default function DashboardFilters({ filters: f, onChange, boroughs, bounds }: Props) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...f, [k]: v });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const hour = (v: string) => (v === "" ? null : Number(v));

  return (
    <div className="card dash-filters">
      <div className="dash-field">
        <span>Dates</span>
        <div className="dash-inline">
          <input type="date" value={f.dateFrom} min={bounds?.dateFrom} max={f.dateTo || bounds?.dateTo}
                 onChange={(e) => e.target.value && set("dateFrom", e.target.value)} />
          <span className="muted">to</span>
          <input type="date" value={f.dateTo} min={f.dateFrom || bounds?.dateFrom} max={bounds?.dateTo}
                 onChange={(e) => e.target.value && set("dateTo", e.target.value)} />
          {bounds && (f.dateFrom !== bounds.dateFrom || f.dateTo !== bounds.dateTo) && (
            <button className="link" onClick={() => onChange({ ...f, ...bounds })}>all dates</button>
          )}
        </div>
      </div>

      <div className="dash-field">
        <span>Days {f.weekdays.length === 0 && <span className="muted">(all)</span>}</span>
        <div className="dash-pills">
          {WEEKDAYS.map((label, i) => (
            <button key={label} className={f.weekdays.includes(i + 1) ? "active" : ""}
                    onClick={() => set("weekdays", toggle(f.weekdays, i + 1).sort())}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="dash-field">
        <span>Hours (pickup or drop-off time)</span>
        <div className="dash-inline">
          <select value={f.hourFrom ?? ""} onChange={(e) => set("hourFrom", hour(e.target.value))}>
            <option value="">from 00:00</option>
            {HOURS.map((h) => <option key={h} value={h}>from {hourLabel(h)}</option>)}
          </select>
          <select value={f.hourTo ?? ""} onChange={(e) => set("hourTo", hour(e.target.value))}>
            <option value="">to 23:59</option>
            {HOURS.map((h) => <option key={h} value={h}>to {hourLabel(h)}:59</option>)}
          </select>
        </div>
        {f.hourFrom !== null && f.hourTo !== null && f.hourFrom > f.hourTo && (
          <span className="muted small">Overnight: {hourLabel(f.hourFrom)} to {hourLabel(f.hourTo)}:59</span>
        )}
      </div>

      <div className="dash-field">
        <span>Boroughs {f.boroughs.length === 0 && <span className="muted">(all)</span>}</span>
        <div className="dash-pills">
          {boroughs.map((b) => (
            <button key={b} className={f.boroughs.includes(b) ? "active" : ""}
                    onClick={() => set("boroughs", toggle(f.boroughs, b))}>
              {b}
            </button>
          ))}
        </div>
      </div>

      <div className="dash-field">
        <span>Colour the map by</span>
        <div className="dash-pills">
          {METRICS.map((m) => (
            <button key={m.value} title={m.help} className={f.metric === m.value ? "active" : ""}
                    onClick={() => set("metric", m.value as Metric)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
