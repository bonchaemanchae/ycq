import { useEffect, useMemo, useState } from "react";
import { toQuery, type Context, type Summary, type Weekdays } from "../dashboard/types";
import { useApi } from "../flows/useApi";
import { DAYS, busiestShifts, endLabel, fleetFor, hourLabel, shiftLabel, type Shift } from "./types";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type Week = {
  ready: boolean;                    // the answers are for the boroughs asked about
  cell: Map<string, number>;         // "dow:hour" -> pickups in that hour on an average day
  grid: Weekdays["grid"];
  error: string;
  loading: boolean;
  months: string;                    // the loaded months the planner learns from, e.g. "Jan–Mar 2026"
  fleetOf: (s: Shift) => number | null;
};

const monthName = (iso: string) =>
  new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" });

// The week for the chosen boroughs, over every loaded date: average pickups for
// every weekday and hour (MongoDB's borough-hour summary, GET /dashboard/weekdays),
// and the average trip time, for the fleet estimate.
export function useWeek(boroughs: string[]): Week {
  const context = useApi<Context>("/dashboard/context");
  const c = context.data;
  const q = c?.dateFrom && c.dateTo && boroughs.length
    ? toQuery({ dateFrom: c.dateFrom, dateTo: c.dateTo, weekdays: [], hourFrom: null, hourTo: null, boroughs,
                metric: "pickups" })
    : null;
  const weekPath = q && `/dashboard/weekdays?${q}`;
  const summaryPath = q && `/dashboard?${q}`;
  const week = useApi<Weekdays>(weekPath);
  const summary = useApi<Summary>(summaryPath);
  const tripSec = summary.path === summaryPath ? summary.data?.totals.averageDurationSec ?? null : null;

  const grid = useMemo(() => week.data?.grid ?? [], [week.data]);
  const cell = useMemo(() => new Map(grid.map((g) => [`${g.isoDayOfWeek}:${g.hour}`, g.averagePickups])), [grid]);
  const months = c?.dateFrom && c.dateTo
    ? (c.dateFrom.slice(0, 7) === c.dateTo.slice(0, 7) ? monthName(c.dateTo) : `${monthName(c.dateFrom)}–${monthName(c.dateTo)}`)
      + ` ${c.dateTo.slice(0, 4)}`
    : "every loaded month";

  // about how many taxis keep up with the shift: its pickups an hour times the average trip
  const fleetOf = (s: Shift) => {
    let sum = 0;
    for (let h = s.from; h <= s.to; h++) sum += cell.get(`${s.dow}:${h}`) ?? 0;
    return fleetFor(sum / (s.to - s.from + 1), tripSec);
  };

  return {
    ready: !!weekPath && week.path === weekPath && !!week.data && summary.path === summaryPath,
    cell, grid, error: week.error || context.error, loading: week.loading, months, fleetOf,
  };
}

type Props = {
  week: Week;
  hasBoroughs: boolean;
  current: Shift;                   // the shift the settings describe, outlined
  onChoose: (shift: Shift) => void;
  allow?: (dow: number, hour: number) => boolean;   // outside it is greyed out (the dashboard's filters)
};

// Choose the shift on the week, darker when busier. Click an hour, or drag
// along a row across several, to plan that weekday and those hours. When the
// planner was opened from the dashboard, the days and hours outside its
// filters are greyed out (still clickable) and Busiest looks only inside them.
export default function WeekGrid({ week, hasBoroughs, current, onChoose, allow }: Props) {
  const { cell, grid } = week;
  const max = Math.max(1, ...cell.values());
  const top = useMemo(() => {
    for (let length = 3; length >= 1; length--) {
      const found = busiestShifts(grid, 3, length, allow);
      if (found.length) return found;
    }
    return [];
  }, [grid, allow]);

  // dragging along one weekday's row
  const [drag, setDrag] = useState<{ dow: number; from: number; to: number } | null>(null);
  useEffect(() => {
    if (!drag) return;
    const end = () => {
      onChoose({ dow: drag.dow, from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) });
      setDrag(null);
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, [drag, onChoose]);

  const shown = drag ? { dow: drag.dow, from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) } : current;
  const inShift = (dow: number, h: number) => dow === shown.dow && h >= shown.from && h <= shown.to;

  if (!hasBoroughs) return <p className="muted small">Pick at least one borough to see its week.</p>;
  return (
    <div className="week-grid">
      <div className="week-head">
        <span><strong>{shiftLabel(shown)}</strong> <span className="muted small">· click an hour, or drag along a row</span></span>
        {top.length > 0 && (
          <span className="week-top">
            <span className="muted small">Busiest{allow ? " in your filters" : ""}:</span>
            {top.map((s) => (
              <button key={`${s.dow}:${s.from}`} className="link" onClick={() => onChoose(s)}>
                {SHORT[s.dow - 1]} {hourLabel(s.from)}–{endLabel(s.to)}
              </button>
            ))}
          </span>
        )}
      </div>
      {week.error && <span className="small danger-text">{week.error}</span>}
      <div className="table-wrap">
        <table className="dash-grid" aria-label="Average pickups by weekday and hour">
          <thead>
            <tr><th />{HOURS.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {DAYS.map((day, i) => {
              const dow = i + 1;
              return (
                <tr key={day}>
                  <th>{SHORT[i]}</th>
                  {HOURS.map((h) => {
                    const v = cell.get(`${dow}:${h}`);
                    const outside = allow ? !allow(dow, h) : false;
                    return (
                      <td key={h} className={`pickable ${inShift(dow, h) ? "in-shift" : ""} ${outside ? "outside" : ""}`}
                          title={`${day} ${hourLabel(h)}: ${v === undefined ? "no data" : `${Math.round(v).toLocaleString()} pickups on an average day`}${outside ? " (outside your dashboard filters)" : ""}`}
                          style={{ background: v === undefined ? undefined : `rgba(230, 160, 0, ${0.06 + 0.94 * (v / max)})` }}
                          onMouseDown={(e) => { e.preventDefault(); setDrag({ dow, from: h, to: h }); }}
                          onMouseEnter={() => drag && drag.dow === dow && setDrag({ ...drag, to: h })} />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!week.ready && week.loading && <span className="muted small">Loading the week…</span>}
    </div>
  );
}
