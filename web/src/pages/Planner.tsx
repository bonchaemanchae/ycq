import { useEffect, useMemo, useState } from "react";
import { api, post, type Borough } from "../api";
import ZoneMap from "../components/ZoneMap";

// Allocation Planner (Anna). Backend routes are in api/routers/plans.py,
// logic in api/planner.py.
// Done so far: settings, preview, save as a new version.
// Still to build: editing final taxis (with a "left to place" counter per
// hour), opening a saved version, rename/delete, and comparing versions.

type Allocation = {
  hour: number;
  location_id: number;
  zone_name: string;
  borough: string;
  rank: number;
  score: string;
  sample_size: number;
  proposed_taxis: number;
  reason: string;
};
type Preview = { allocations: Allocation[]; empty_hours: number[] };
type PlanSummary = {
  allocation_plan_id: number;
  name: string;
  latest_version: number | null;
  total_taxis: number;
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function Planner() {
  const [boroughs, setBoroughs] = useState<Borough[]>([]);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [planId, setPlanId] = useState<number | null>(null);
  const [settings, setSettings] = useState({
    fleet_size: 100, iso_dow: 1, start_hour: 7, end_hour: 9,
    borough_ids: [] as number[], max_zones_per_hour: 10, min_sample: 30,
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hour, setHour] = useState(7);
  const [message, setMessage] = useState("");

  const loadPlans = () => api<PlanSummary[]>("/plans").then(setPlans);
  useEffect(() => {
    api<Borough[]>("/boroughs").then((b) => {
      setBoroughs(b);
      setSettings((s) => ({ ...s, borough_ids: b.filter((x) => x.name === "Manhattan").map((x) => x.borough_id) }));
    });
    loadPlans();
  }, []);

  const set = (key: keyof typeof settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setSettings({ ...settings, [key]: Number(e.target.value) });

  const run = async (action: () => Promise<void>) => {
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const doPreview = () => run(async () => {
    const p = await post<Preview>("/plans/preview", settings);
    setPreview(p);
    setHour(settings.start_hour);
    if (p.empty_hours.length) setMessage(`No eligible zones at hour(s) ${p.empty_hours.join(", ")}`);
  });

  const newPlan = () => run(async () => {
    const name = prompt("Plan name");
    if (!name) return;
    const { allocation_plan_id } = await post<{ allocation_plan_id: number }>("/plans", { name });
    setPlanId(allocation_plan_id);
    await loadPlans();
  });

  const save = () => run(async () => {
    if (planId === null) throw new Error("Pick or create a plan first");
    const { version_no } = await post<{ version_no: number }>(`/plans/${planId}/versions`, { settings, edits: [] });
    setMessage(`Saved as version ${version_no}`);
    await loadPlans();
  });

  const byHour = useMemo(() => {
    const out: Record<number, Allocation[]> = {};
    preview?.allocations.forEach((a) => (out[a.hour] ??= []).push(a));
    return out;
  }, [preview]);
  const mapValues = Object.fromEntries((byHour[hour] ?? []).map((a) => [a.location_id, a.proposed_taxis]));

  return (
    <section>
      <h1>Allocation Planner</h1>
      <div className="row">
        <label>Plan{" "}
          <select value={planId ?? ""} onChange={(e) => setPlanId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">(none)</option>
            {plans.map((p) => (
              <option key={p.allocation_plan_id} value={p.allocation_plan_id}>
                {p.name} {p.latest_version ? `(v${p.latest_version})` : "(no versions)"}
              </option>
            ))}
          </select>
        </label>
        <button onClick={newPlan}>New plan</button>
      </div>

      <div className="row">
        <label>Fleet <input type="number" min={1} value={settings.fleet_size} onChange={set("fleet_size")} /></label>
        <label>Day{" "}
          <select value={settings.iso_dow} onChange={set("iso_dow")}>
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select>
        </label>
        <label>From <input type="number" min={0} max={23} value={settings.start_hour} onChange={set("start_hour")} /></label>
        <label>To <input type="number" min={0} max={23} value={settings.end_hour} onChange={set("end_hour")} /></label>
        <label>Zones/hour <input type="number" min={1} value={settings.max_zones_per_hour} onChange={set("max_zones_per_hour")} /></label>
        <label>Min trips <input type="number" min={0} value={settings.min_sample} onChange={set("min_sample")} /></label>
      </div>
      <div className="row">
        {boroughs.map((b) => (
          <label key={b.borough_id}>
            <input
              type="checkbox"
              checked={settings.borough_ids.includes(b.borough_id)}
              onChange={(e) => setSettings({
                ...settings,
                borough_ids: e.target.checked
                  ? [...settings.borough_ids, b.borough_id]
                  : settings.borough_ids.filter((id) => id !== b.borough_id),
              })}
            /> {b.name}
          </label>
        ))}
      </div>
      <div className="row">
        <button onClick={doPreview}>Preview</button>
        <button onClick={save} disabled={!preview}>Save as new version</button>
        {message && <span className="message">{message}</span>}
      </div>

      {preview && (
        <div className="split">
          <div>
            <div className="row">
              {Object.keys(byHour).map((h) => (
                <button key={h} className={Number(h) === hour ? "active" : ""} onClick={() => setHour(Number(h))}>
                  {h}:00
                </button>
              ))}
            </div>
            <table>
              <thead>
                <tr><th>#</th><th>Zone</th><th>Borough</th><th>Score</th><th>Taxis</th><th>Why</th></tr>
              </thead>
              <tbody>
                {(byHour[hour] ?? []).map((a) => (
                  <tr key={a.location_id}>
                    <td>{a.rank}</td><td>{a.zone_name}</td><td>{a.borough}</td>
                    <td>{a.score}</td><td>{a.proposed_taxis}</td><td>{a.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ZoneMap values={mapValues} label="taxis" />
        </div>
      )}
    </section>
  );
}
