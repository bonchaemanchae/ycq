import { useEffect, useMemo, useState } from "react";
import { useApi } from "../flows/useApi";
import { DAYS, busiestShifts, endLabel, hourLabel, shiftLabel, type Shift } from "../planner/types";
import { toQuery, type Filters, type Weekdays } from "./types";

type Props = {
  filters: Filters;
  carried: string[];               // what goes to the planner besides the shift, in words
  onPlan: (shift: Shift) => void;
  onClose: () => void;
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Asked when the filters don't name one shift (one weekday and an hour range):
// the busiest shifts for the filters, or any weekday and hours. Nothing is
// typed twice; the planner opens on the shift chosen here.
export default function PlanChooser({ filters, carried, onPlan, onClose }: Props) {
  const week = useApi<Weekdays>(`/dashboard/weekdays?${toQuery({ ...filters, weekdays: [], hourFrom: null, hourTo: null })}`);
  const top = useMemo(() => busiestShifts(week.data?.grid ?? [], 3), [week.data]);
  const [custom, setCustom] = useState<Shift>({ dow: 4, from: 17, to: 19 });
  useEffect(() => {
    if (top.length) setCustom({ dow: top[0].dow, from: top[0].from, to: top[0].to });
  }, [top]);
  const valid = custom.from <= custom.to;

  return (
    <div className="card plan-chooser">
      <div className="card-head">
        <div className="card-title">
          Which shift do you want to plan?
          <div className="card-sub">Plans learn from every loaded month.</div>
        </div>
        <button className="link" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="plan-options">
        {week.loading && !week.data && <span className="muted small">Finding the busiest shifts…</span>}
        {top.map((s) => (
          <button key={`${s.dow}:${s.from}`} className="suggested-item" onClick={() => onPlan(s)}>
            <span className="suggested-when">{DAYS[s.dow - 1].slice(0, 3)} {hourLabel(s.from)}–{endLabel(s.to)}</span>
            <span className="muted small">{Math.round(s.pickups).toLocaleString()} pickups on an average day</span>
          </button>
        ))}
        <div className="plan-custom">
          <select value={custom.dow} onChange={(e) => setCustom({ ...custom, dow: Number(e.target.value) })} aria-label="Weekday">
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select>
          <select value={custom.from} onChange={(e) => setCustom({ ...custom, from: Number(e.target.value) })} aria-label="From">
            {HOURS.map((h) => <option key={h} value={h}>from {hourLabel(h)}</option>)}
          </select>
          <select value={custom.to} onChange={(e) => setCustom({ ...custom, to: Number(e.target.value) })} aria-label="To">
            {HOURS.map((h) => <option key={h} value={h}>to {endLabel(h)}</option>)}
          </select>
          <button className="primary" disabled={!valid} onClick={() => onPlan(custom)}>
            Plan {valid ? shiftLabel(custom) : "this shift"} →
          </button>
        </div>
      </div>
      {carried.length > 0 && <p className="muted small plan-carried">Also taken to the planner: {carried.join(" · ")}.</p>}
    </div>
  );
}
