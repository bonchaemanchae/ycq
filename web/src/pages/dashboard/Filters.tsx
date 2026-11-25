import { useState, type ReactNode } from "react";
import { WEEKDAYS, hourLabel, type Filters } from "./types";

type Props = {
  filters: Filters;
  onChange: (f: Filters) => void;
  boroughs: string[];
  bounds: { dateFrom: string; dateTo: string } | null;   // the loaded date range
  actions?: ReactNode;                                   // Views and Allocate taxis, on the right
  below?: ReactNode;                                     // shown under the bar, e.g. the shift chooser
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const day = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// The filters in words, e.g. "1 Jan 2026 – 31 Mar 2026 · Mon, Tue · 17:00–20:00 · Manhattan".
export function describeFilters(f: Filters): string[] {
  const days = f.weekdays.length === 0 ? "All days"
    : f.weekdays.join() === "1,2,3,4,5" ? "Weekdays"
    : f.weekdays.join() === "6,7" ? "Weekends"
    : f.weekdays.map((d) => WEEKDAYS[d - 1]).join(", ");
  const hours = f.hourFrom === null && f.hourTo === null ? "All hours"
    : `${hourLabel(f.hourFrom ?? 0)}–${f.hourTo === null || f.hourTo === 23 ? "midnight" : hourLabel(f.hourTo + 1)}`;
  return [`${day(f.dateFrom)} – ${day(f.dateTo)}`, days, hours, f.boroughs.length ? f.boroughs.join(", ") : "All boroughs"];
}

// The dashboard's toolbar: the filters in one line (any filter that is on
// shows as a yellow chip with a remove button, the defaults as plain words), the page's
// actions on the right, and the full filters in a panel that opens under it.
// It stays at the top of the window while the page scrolls, so the filters
// and the actions are always in view, whichever section is on screen.
// Changes in the panel are a draft until Apply, so the numbers reload once,
// not on every click; Cancel (or the Filters button) closes it unapplied.
export default function FilterBar({ filters: f, onChange, boroughs, bounds, actions, below }: Props) {
  const [open, setOpen] = useState(false);
  const [d, setDraft] = useState<Filters>(f);           // the panel's unapplied filters
  const openPanel = () => {
    setDraft(f);
    setOpen(true);
  };
  const apply = () => {
    onChange(d);
    setOpen(false);
  };
  // each change builds on the latest draft, so quick clicks can't undo one another
  const set = <K extends keyof Filters>(k: K, v: (current: Filters[K]) => Filters[K]) =>
    setDraft((x) => ({ ...x, [k]: v(x[k]) }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const hour = (v: string) => (v === "" ? null : Number(v));
  const filtered = !!bounds && (f.dateFrom !== bounds.dateFrom || f.dateTo !== bounds.dateTo
    || f.weekdays.length > 0 || f.hourFrom !== null || f.hourTo !== null || f.boroughs.length > 0);
  const reset = () => bounds && onChange({ ...f, ...bounds, weekdays: [], hourFrom: null, hourTo: null, boroughs: [] });

  return (
    <div className="filter-bar">
      <div className="filter-line">
        <button className={`filter-toggle ${open ? "on" : ""}`} onClick={() => (open ? setOpen(false) : openPanel())} aria-expanded={open}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z" /></svg>
          Filters
        </button>
        <div className="filter-summary">
          {describeFilters(f).map((part, i) => {
            const clear = bounds ? [
              f.dateFrom !== bounds.dateFrom || f.dateTo !== bounds.dateTo ? () => onChange({ ...f, ...bounds }) : null,
              f.weekdays.length ? () => onChange({ ...f, weekdays: [] }) : null,
              f.hourFrom !== null || f.hourTo !== null ? () => onChange({ ...f, hourFrom: null, hourTo: null }) : null,
              f.boroughs.length ? () => onChange({ ...f, boroughs: [] }) : null,
            ][i] : null;
            return clear ? (
              <span key={i} className="filter-chip">
                <button className="filter-chip-label" onClick={openPanel} title="Change the filters">{part}</button>
                <button className="filter-chip-x" onClick={clear} aria-label={`Remove the filter ${part}`} title="Remove this filter">✕</button>
              </span>
            ) : (
              <button key={i} className="filter-part" onClick={openPanel} title="Change the filters">{part}</button>
            );
          })}
        </div>
        {filtered && !open && <button className="link" onClick={reset}>Reset</button>}
        {actions && <div className="filter-actions">{actions}</div>}
      </div>

      {open && (
        <div className="filter-panel">
          <div className="dash-filters">
            <div className="dash-field">
              <span>Dates</span>
              <div className="dash-inline">
                <input type="date" value={d.dateFrom} min={bounds?.dateFrom} max={d.dateTo || bounds?.dateTo}
                       onChange={(e) => e.target.value && set("dateFrom", () => e.target.value)} />
                <span className="muted">to</span>
                <input type="date" value={d.dateTo} min={d.dateFrom || bounds?.dateFrom} max={bounds?.dateTo}
                       onChange={(e) => e.target.value && set("dateTo", () => e.target.value)} />
                {bounds && (d.dateFrom !== bounds.dateFrom || d.dateTo !== bounds.dateTo) && (
                  <button className="link" onClick={() => onChange({ ...f, ...bounds })}>all dates</button>
                )}
              </div>
            </div>

            <div className="dash-field">
              <span>Days {d.weekdays.length === 0 && <span className="muted">(all)</span>}</span>
              <div className="dash-pills">
                {WEEKDAYS.map((label, i) => (
                  <button key={label} className={d.weekdays.includes(i + 1) ? "active" : ""}
                          onClick={() => set("weekdays", (w) => toggle(w, i + 1).sort())}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="dash-field">
              <span>Hours</span>
              <div className="dash-inline">
                <select value={d.hourFrom ?? ""} onChange={(e) => set("hourFrom", () => hour(e.target.value))}>
                  <option value="">from 00:00</option>
                  {HOURS.map((h) => <option key={h} value={h}>from {hourLabel(h)}</option>)}
                </select>
                <select value={d.hourTo ?? ""} onChange={(e) => set("hourTo", () => hour(e.target.value))}>
                  <option value="">to 23:59</option>
                  {HOURS.map((h) => <option key={h} value={h}>to {hourLabel(h)}:59</option>)}
                </select>
              </div>
              {d.hourFrom !== null && d.hourTo !== null && d.hourFrom > d.hourTo && (
                <span className="muted small">Overnight: {hourLabel(d.hourFrom)} to {hourLabel(d.hourTo)}:59</span>
              )}
            </div>

            <div className="dash-field">
              <span>Boroughs {d.boroughs.length === 0 && <span className="muted">(all)</span>}</span>
              <div className="dash-pills">
                {boroughs.map((b) => (
                  <button key={b} className={d.boroughs.includes(b) ? "active" : ""}
                          onClick={() => set("boroughs", (list) => toggle(list, b))}>
                    {b}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-done">
              <button className="link" onClick={() => setOpen(false)}>Cancel</button>
              <button className="primary" onClick={apply}>Apply</button>
            </div>
          </div>
        </div>
      )}
      {below}
    </div>
  );
}
