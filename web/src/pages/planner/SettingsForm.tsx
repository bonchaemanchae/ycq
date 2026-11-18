import type { ReactNode } from "react";
import type { Borough } from "../../api";
import { DAYS, DEFAULT_WEIGHTS, METRICS, hourLabel, weightSum, type Settings } from "./types";

type Props = {
  settings: Settings;
  onChange: (s: Settings) => void;
  boroughs: Borough[];
  onPreview: () => void;
  busy: boolean;
  stale: boolean;
  suggestions?: ReactNode;   // shifts worth planning, shown above the fields
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Plan settings. The four a fleet manager decides (fleet, day, hours,
// boroughs) are always shown; eligibility and the scoring weights are under
// "Advanced", with defaults that work.
export default function SettingsForm({ settings: s, onChange, boroughs, onPreview, busy, stale, suggestions }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...s, [k]: v });
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    set(k, Number(e.target.value) as never);

  const sum = weightSum(s);
  const problems = [
    s.fleet_size < 1 && "Fleet size must be at least 1",
    s.start_hour > s.end_hour && "“From” must not be after “To”",
    s.borough_ids.length === 0 && "Pick at least one borough",
    sum !== 1 && `Weights add up to ${sum.toFixed(2)}, not 1`,
  ].filter(Boolean) as string[];

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          1. Choose the shift <div className="card-sub">Your fleet, the weekday, the hours and the boroughs to cover.</div>
        </div>
        {stale && <span className="tag warn">Changed since preview</span>}
      </div>
      {suggestions}

      <div className="form-grid">
        <label className="field">
          <span>Fleet size</span>
          <input type="number" min={1} max={100000} value={s.fleet_size} onChange={num("fleet_size")} />
        </label>
        <label className="field">
          <span>Day</span>
          <select value={s.iso_dow} onChange={num("iso_dow")}>
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select>
        </label>
        <label className="field">
          <span>From</span>
          <select value={s.start_hour} onChange={num("start_hour")}>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>To (inclusive)</span>
          <select value={s.end_hour} onChange={num("end_hour")}>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
      </div>

      <div className="field">
        <span>Boroughs</span>
        <div className="chips">
          {boroughs.map((b) => {
            const on = s.borough_ids.includes(b.borough_id);
            return (
              <button key={b.borough_id} type="button" className={`chip ${on ? "on" : ""}`}
                      onClick={() => set("borough_ids", on
                        ? s.borough_ids.filter((id) => id !== b.borough_id)
                        : [...s.borough_ids, b.borough_id])}>
                {b.name}
              </button>
            );
          })}
        </div>
      </div>

      <details className="advanced">
        <summary>
          Advanced settings{" "}
          <span className="muted small">
            · {s.max_zones_per_hour} zones per hour · at least {s.min_sample} pickups · weights{" "}
            {METRICS.map((m) => s[m.weight].toFixed(2)).join(" / ")}
          </span>
        </summary>
        <div className="form-grid">
          <label className="field" title="The best-scoring zones kept each hour">
            <span>Zones per hour</span>
            <input type="number" min={1} max={263} value={s.max_zones_per_hour} onChange={num("max_zones_per_hour")} />
          </label>
          <label className="field" title="A zone needs at least this many pickups in that hour across all loaded days">
            <span>Min. pickups</span>
            <input type="number" min={0} value={s.min_sample} onChange={num("min_sample")} />
          </label>
        </div>
      <div className="field">
        <span>
          Scoring weights{" "}
          <span className={`small ${sum === 1 ? "muted" : "danger-text"}`}>(total {sum.toFixed(2)} of 1)</span>
          {" "}
          <button type="button" className="link small" onClick={() => onChange({ ...s, ...DEFAULT_WEIGHTS })}>
            reset
          </button>
        </span>
        <div className="weights">
          {METRICS.map((m) => (
            <label key={m.weight} className="weight" title={m.help}>
              <span className="dot" style={{ background: m.color }} />
              <span className="weight-label">{m.label}</span>
              <input type="range" min={0} max={1} step={0.05} value={s[m.weight]}
                     onChange={(e) => set(m.weight, Number(e.target.value))} />
              <input type="number" min={0} max={1} step={0.05} value={s[m.weight]}
                     onChange={(e) => set(m.weight, Number(e.target.value))} />
            </label>
          ))}
        </div>
      </div>
      </details>

      <div className="card-foot">
        {problems.length > 0
          ? <span className="small danger-text">{problems[0]}</span>
          : <span className="small muted">Scores every eligible zone from all loaded months.</span>}
        <button className="primary" onClick={onPreview} disabled={busy || problems.length > 0}>
          {busy ? "Scoring…" : stale ? "Preview again" : "Preview"}
        </button>
      </div>
    </div>
  );
}
