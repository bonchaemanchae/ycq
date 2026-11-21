import { useEffect, useRef, useState } from "react";
import type { Borough } from "../../api";
import { DAYS, METRICS, endLabel, hourLabel, settingsProblems, type Settings } from "./types";

type Props = {
  settings: Settings;
  onChange: (s: Settings) => void;
  boroughs: Borough[];
  fleetIsEstimate: boolean;  // the taxis are the planner's estimate, not typed by the manager
  onFleet: (n: number | null) => void;   // a typed fleet, or null when the box is emptied
  peak: { taxis: number; hour: string } | null;   // the busiest hour's demand
  updating: boolean;         // the plan below is being worked out again
  details: boolean;          // admins' database details: show the ranking weights
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Step 1: the five things a fleet manager decides (the weekday, the hours,
// how many taxis, which boroughs), on one line. Every change updates the
// plan below by itself, so there is no Preview button. How zones are ranked
// is fixed at the defaults (stored with every version); only admins see the
// weights.
export default function SettingsForm({ settings: s, onChange, boroughs, fleetIsEstimate, onFleet, peak, updating,
                                       details }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...s, [k]: v });
  const latest = useRef(s);
  latest.current = s;

  // The taxis box: empty with the estimate in grey while it's the planner's,
  // the manager's own number in black once typed. It applies 300 ms after the
  // last keystroke, so typing 2750 asks for one new plan, not four.
  const [fleetText, setFleetText] = useState(fleetIsEstimate ? "" : String(s.fleet_size));
  useEffect(() => setFleetText(fleetIsEstimate ? "" : String(s.fleet_size)), [s.fleet_size, fleetIsEstimate]);
  useEffect(() => {
    if (fleetText === "") {
      if (fleetIsEstimate) return;
      const t = setTimeout(() => onFleet(null), 300);
      return () => clearTimeout(t);
    }
    const n = Math.min(Math.floor(Number(fleetText)), 100000);
    if (!Number.isFinite(n) || (!fleetIsEstimate && n === latest.current.fleet_size)) return;
    const t = setTimeout(() => onFleet(n), 300);
    return () => clearTimeout(t);
  }, [fleetText]);   // eslint-disable-line react-hooks/exhaustive-deps

  const problems = settingsProblems(s);

  return (
    <div className="card settings" aria-label="Shift, taxis and area">
      <div className="settings-row">
        <label className="field">
          <span>Day</span>
          <select value={s.iso_dow} onChange={(e) => set("iso_dow", Number(e.target.value))}>
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select>
        </label>
        <label className="field">
          <span>From</span>
          <select value={s.start_hour} onChange={(e) => set("start_hour", Number(e.target.value))}>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>To</span>
          {/* the last hour of the shift, shown as the time it ends: 19 reads 20:00 */}
          <select value={s.end_hour} onChange={(e) => set("end_hour", Number(e.target.value))}>
            {HOURS.map((h) => <option key={h} value={h}>{endLabel(h)}</option>)}
          </select>
        </label>
        <label className="field taxis">
          <span>Taxis</span>
          <input type="text" inputMode="numeric" value={fleetText} placeholder={`≈${s.fleet_size.toLocaleString()}`}
                 title={(peak ? `Demand peaks at about ${peak.taxis.toLocaleString()} taxis (${peak.hour}). ` : "") +
                   (fleetIsEstimate ? "Type how many taxis you have." : "Clear the box to go back to the estimate.")}
                 onChange={(e) => setFleetText(e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, ""))} />
        </label>
        <div className="field">
          <span>Boroughs</span>
          <BoroughPicker boroughs={boroughs} chosen={s.borough_ids} onChange={(ids) => set("borough_ids", ids)} />
        </div>
        {updating && <span className="muted small settings-updating">Updating the plan…</span>}
      </div>

      {details && (
        <p className="ranking-weights small muted">
          Ranking weights: {METRICS.map((m) => `${m.label} ${s[m.weight].toFixed(2)}`).join(", ")}; up to{" "}
          {s.max_zones_per_hour} zones an hour; recommended from {s.min_sample} pickups (the weights add up to 1,
          checked by PostgreSQL)
        </p>
      )}
      {problems.length > 0 && <p className="small danger-text settings-problem">{problems[0]}</p>}
    </div>
  );
}

// "All boroughs ▾" or "Manhattan, Queens ▾", opening a list of checkboxes.
function BoroughPicker({ boroughs, chosen, onChange }: {
  boroughs: Borough[]; chosen: number[]; onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const names = boroughs.filter((b) => chosen.includes(b.borough_id)).map((b) => b.name);
  const label = names.length === 0 ? "None chosen"
    : names.length === boroughs.length ? "All boroughs"
    : names.length <= 2 ? names.join(", ") : `${names.length} boroughs`;
  return (
    <div className="borough-picker" ref={box}>
      <button type="button" className="borough-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="borough-menu">
          <div className="borough-all">
            <button type="button" className="link small" onClick={() => onChange(boroughs.map((b) => b.borough_id))}>All</button>
            <button type="button" className="link small" onClick={() => onChange([])}>None</button>
          </div>
          {boroughs.map((b) => (
            <label key={b.borough_id} className="borough-option">
              <input type="checkbox" checked={chosen.includes(b.borough_id)}
                     onChange={() => onChange(chosen.includes(b.borough_id)
                       ? chosen.filter((id) => id !== b.borough_id) : [...chosen, b.borough_id])} />
              {b.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
