import { useEffect, useMemo, useState } from "react";
import { toQuery, type Context, type Weekdays } from "../dashboard/types";
import { useApi } from "../flows/useApi";
import { DAYS, busiestShifts, endLabel, hourLabel, shiftLabel, type Shift } from "./types";

type Props = {
  boroughs: string[];               // names of the boroughs chosen in the settings
  current: Shift;                   // the shift the settings describe, outlined
  onChoose: (shift: Shift) => void;
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Choose the shift on the week: average pickups per day for every weekday and
// hour in the chosen boroughs, darker when busier. Click an hour, or drag
// along a row across several, to plan that weekday and those hours. Read from
// MongoDB's borough-hour summary (GET /dashboard/weekdays) over every loaded date.
export default function WeekGrid({ boroughs, current, onChoose }: Props) {
  const context = useApi<Context>("/dashboard/context");
  const c = context.data;
  const q = c?.dateFrom && c.dateTo && boroughs.length
    ? toQuery({ dateFrom: c.dateFrom, dateTo: c.dateTo, weekdays: [], hourFrom: null, hourTo: null, boroughs,
                metric: "pickups" })
    : null;
  const week = useApi<Weekdays>(q && `/dashboard/weekdays?${q}`);

  const cell = useMemo(() => new Map((week.data?.grid ?? []).map((g) => [`${g.isoDayOfWeek}:${g.hour}`, g.averagePickups])),
                       [week.data]);
  const max = Math.max(1, ...cell.values());
  const top = useMemo(() => busiestShifts(week.data?.grid ?? [], 3), [week.data]);

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

  if (!boroughs.length) return <p className="muted small">Pick at least one borough to see its week.</p>;
  return (
    <div className="week-grid">
      <div className="week-head">
        <span><strong>{shiftLabel(shown)}</strong> <span className="muted small">· click an hour, or drag along a row</span></span>
        {top.length > 0 && (
          <span className="week-top">
            <span className="muted small">Busiest:</span>
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
                    return (
                      <td key={h} className={`pickable ${inShift(dow, h) ? "in-shift" : ""}`}
                          title={`${day} ${hourLabel(h)}: ${v === undefined ? "no data" : `${Math.round(v).toLocaleString()} pickups on an average day`}`}
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
      {!week.data && week.loading && <span className="muted small">Loading the week…</span>}
    </div>
  );
}
