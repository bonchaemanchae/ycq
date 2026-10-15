import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, del, patch, post, type Borough } from "../api";
import ZoneMap from "../components/ZoneMap";
import AllocationTable, { type TableRow } from "./planner/AllocationTable";
import ComparePanel from "./planner/ComparePanel";
import PlansPanel from "./planner/PlansPanel";
import SettingsForm from "./planner/SettingsForm";
import StoreCheck from "./planner/StoreCheck";
import VersionsPanel from "./planner/VersionsPanel";
import {
  DEFAULT_WEIGHTS, METRICS, hourLabel, key, toRequest,
  type Change, type PlanSummary, type Preview, type Row, type SavedVersion, type Settings, type VersionSummary,
} from "./planner/types";
import "./planner/planner.css";

// Allocation Planner (Anna). Backend routes are in api/routers/plans.py,
// scoring and saving in api/planner.py, rules in sql/006 and sql/011.
//
// Flow: pick settings -> Preview scores every eligible zone and splits the
// fleet -> the analyst adjusts the final taxis (every hour must add up to the
// fleet) -> Save stores a new version of the plan in one transaction.

type Message = { kind: "error" | "ok"; text: string } | null;
type HourSlot = { rows: TableRow[]; candidates: Row[]; left: number };

const INITIAL: Settings = {
  fleet_size: 100, iso_dow: 1, start_hour: 7, end_hour: 9, borough_ids: [],
  max_zones_per_hour: 10, min_sample: 30, ...DEFAULT_WEIGHTS,
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export default function Planner() {
  const [boroughs, setBoroughs] = useState<Borough[]>([]);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [planId, setPlanId] = useState<number | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [openVersion, setOpenVersion] = useState<number | null>(null);

  const [settings, setSettings] = useState<Settings>(INITIAL);
  // The preview and the settings it was scored with. Saving always uses these.
  const [scored, setScored] = useState<{ settings: Settings; preview: Preview } | null>(null);
  // Final taxis the analyst changed, by "hour:location_id".
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [hour, setHour] = useState(INITIAL.start_hour);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [compare, setCompare] = useState<{ from: VersionSummary; to: VersionSummary; changes: Change[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const loadPlans = () => api<PlanSummary[]>("/plans").then(setPlans);
  const loadVersions = async (id: number) => {
    const v = await api<VersionSummary[]>(`/plans/${id}/versions`);
    setVersions(v);
    return v;
  };

  useEffect(() => {
    run(async () => {
      const b = await api<Borough[]>("/boroughs");
      setBoroughs(b);
      setSettings((s) => ({ ...s, borough_ids: b.filter((x) => x.name === "Manhattan").map((x) => x.borough_id) }));
      await loadPlans();
    });
  }, []);

  // --- scoring ---------------------------------------------------------------

  const score = async (s: Settings) => {
    const preview = await post<Preview>("/plans/preview", toRequest(s));
    setScored({ settings: s, preview });
    setHour(s.start_hour);
    setFocusId(null);
    return preview;
  };

  const doPreview = () => run(async () => {
    const p = await score(settings);
    setEdits({});
    setOpenVersion(null);
    if (p.empty_hours.length) {
      setMessage({ kind: "error", text:
        `No zone has ${settings.min_sample}+ pickups at ${p.empty_hours.map(hourLabel).join(", ")}. ` +
        "Lower the minimum pickups or add boroughs." });
    }
  });

  // Loads a saved version: its settings, a fresh score, and its final taxis as edits.
  const openSaved = async (id: number, versionNo: number) => {
    const v = await api<SavedVersion>(`/plans/${id}/versions/${versionNo}`);
    const s: Settings = {
      fleet_size: v.fleet_size, iso_dow: v.iso_dow, start_hour: v.start_hour, end_hour: v.end_hour,
      borough_ids: v.borough_ids, max_zones_per_hour: v.max_zones_per_hour, min_sample: v.min_sample,
      w_pickup: Number(v.w_pickup), w_imbalance: Number(v.w_imbalance),
      w_consistency: Number(v.w_consistency), w_fare: Number(v.w_fare),
    };
    setSettings(s);
    const p = await score(s);
    const saved = new Map(v.results.map((r) => [key(r.hour, r.location_id), r.final_taxis]));
    const next: Record<string, number> = {};
    for (const r of p.allocations) {
      const k = key(r.hour, r.location_id);
      const final = saved.get(k) ?? 0;
      if (final !== r.proposed_taxis) next[k] = final;
    }
    for (const r of p.candidates) {
      const final = saved.get(key(r.hour, r.location_id));
      if (final) next[key(r.hour, r.location_id)] = final;
    }
    setEdits(next);
    setOpenVersion(versionNo);
    setNote("");
  };

  // --- plans (CRUD) ----------------------------------------------------------

  const selectPlan = (id: number) => run(async () => {
    setPlanId(id);
    setCompare(null);
    const v = await loadVersions(id);
    if (v.length) await openSaved(id, v[0].version_no);
    else setOpenVersion(null);
  });

  const createPlan = (name: string) => run(async () => {
    const { allocation_plan_id } = await post<{ allocation_plan_id: number }>("/plans", { name });
    await loadPlans();
    setPlanId(allocation_plan_id);
    setVersions([]);
    setOpenVersion(null);
    setCompare(null);
    setMessage({ kind: "ok", text: `Created “${name}”. Preview, adjust, then save it as version 1.` });
  });

  const renamePlan = (id: number, name: string) => run(async () => {
    await patch(`/plans/${id}`, { name });
    await loadPlans();
  });

  const deletePlan = (id: number) => run(async () => {
    await del(`/plans/${id}`);
    if (id === planId) {
      setPlanId(null);
      setVersions([]);
      setOpenVersion(null);
      setCompare(null);
    }
    await loadPlans();
  });

  const compareVersions = (from: number, to: number) => run(async () => {
    const changes = await api<Change[]>(`/plans/${planId}/compare?from_version=${from}&to_version=${to}`);
    setCompare({
      from: versions.find((v) => v.version_no === from)!,
      to: versions.find((v) => v.version_no === to)!,
      changes,
    });
  });

  // --- the allocation being edited --------------------------------------------

  const fleet = scored?.settings.fleet_size ?? 0;
  const hours = scored ? range(scored.settings.start_hour, scored.settings.end_hour) : [];
  const stale = scored !== null && JSON.stringify(settings) !== JSON.stringify(scored.settings);

  const byHour = useMemo(() => {
    const out: Record<number, HourSlot> = {};
    if (!scored) return out;
    for (const h of range(scored.settings.start_hour, scored.settings.end_hour)) {
      out[h] = { rows: [], candidates: [], left: 0 };
    }
    for (const r of scored.preview.allocations) {
      out[r.hour].rows.push({ ...r, final: edits[key(r.hour, r.location_id)] ?? r.proposed_taxis, added: false });
    }
    for (const r of scored.preview.candidates) {
      const k = key(r.hour, r.location_id);
      if (k in edits) out[r.hour].rows.push({ ...r, final: edits[k], added: true });
      else out[r.hour].candidates.push(r);
    }
    for (const slot of Object.values(out)) {
      slot.rows.sort((a, b) => a.rank - b.rank);
      slot.left = scored.settings.fleet_size - slot.rows.reduce((n, r) => n + r.final, 0);
    }
    return out;
  }, [scored, edits]);

  const setFinal = (row: Row, taxis: number) => {
    const k = key(row.hour, row.location_id);
    const next = { ...edits };
    if (row.selected && taxis === row.proposed_taxis) delete next[k];
    else next[k] = taxis;
    setEdits(next);
  };

  const addRow = (row: Row) => {
    setEdits({ ...edits, [key(row.hour, row.location_id)]: 0 });
    setFocusId(row.location_id);
  };

  const removeRow = (row: Row) => {
    const next = { ...edits };
    delete next[key(row.hour, row.location_id)];
    setEdits(next);
  };

  // Puts the taxis still to place on the top zone, or takes the excess from
  // the lowest-ranked zones, so the hour adds up to the fleet.
  const balance = (h: number) => {
    const { rows, left } = byHour[h];
    const next = { ...edits };
    const set = (r: TableRow, v: number) => {
      const k = key(r.hour, r.location_id);
      if (r.selected && v === r.proposed_taxis) delete next[k];
      else next[k] = v;
    };
    if (left > 0) {
      set(rows[0], rows[0].final + left);
    } else {
      let over = -left;
      for (const r of [...rows].reverse()) {
        const take = Math.min(r.final, over);
        if (take > 0) set(r, r.final - take);
        over -= take;
        if (over === 0) break;
      }
    }
    setEdits(next);
  };

  // Clicking a zone on the map finds it in the table, or adds it if eligible.
  const zoneClick = useRef<(id: number) => void>(() => {});
  zoneClick.current = (id: number) => {
    const slot = byHour[hour];
    if (!slot) return;
    if (slot.rows.some((r) => r.location_id === id)) return setFocusId(id);
    const candidate = slot.candidates.find((r) => r.location_id === id);
    if (candidate) return addRow(candidate);
    setMessage({ kind: "error", text:
      `That zone isn't eligible at ${hourLabel(hour)}: it's outside the chosen boroughs ` +
      `or had fewer than ${scored?.settings.min_sample} pickups.` });
  };
  const onZoneClick = useCallback((id: number) => zoneClick.current(id), []);

  const slot = byHour[hour];
  const mapValues = Object.fromEntries((slot?.rows ?? []).filter((r) => r.final > 0).map((r) => [r.location_id, r.final]));
  const allRows = Object.values(byHour).flatMap((s) => s.rows);
  const changed = allRows.filter((r) => (r.added ? r.final > 0 : r.final !== r.proposed_taxis));
  const zonesUsed = new Set(allRows.filter((r) => r.final > 0).map((r) => r.location_id)).size;
  const unbalanced = hours.filter((h) => byHour[h].left !== 0);
  const nextVersion = (versions[0]?.version_no ?? 0) + 1;

  const blocker =
    planId === null ? "Create or pick a plan on the left to save this allocation." :
    stale ? "The settings changed since the preview. Preview again before saving." :
    unbalanced.length ? `${unbalanced.map(hourLabel).join(", ")} ${unbalanced.length > 1 ? "don't" : "doesn't"} add up to the fleet of ${fleet} yet.` :
    null;

  const save = () => run(async () => {
    if (!scored || planId === null) return;
    const { version_no } = await post<{ version_no: number }>(`/plans/${planId}/versions`, {
      settings: toRequest(scored.settings, note.trim() || undefined),
      edits: changed.map((r) => ({ hour: r.hour, location_id: r.location_id, final_taxis: r.final })),
    });
    await Promise.all([loadPlans(), loadVersions(planId)]);
    setOpenVersion(version_no);
    setNote("");
    setMessage({ kind: "ok", text: `Saved as version ${version_no}.` });
  });

  return (
    <section className="planner">
      <div className="page-head">
        <h1>Allocation Planner</h1>
        <p className="muted">
          Score taxi zones hour by hour, split a fleet across the best ones, adjust and save versions.
          Results are planning scenarios from historical trips, not live taxi availability.
        </p>
      </div>

      {message && (
        <div className={`alert ${message.kind}`}>
          <span>{message.text}</span>
          <button className="link" onClick={() => setMessage(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="planner-layout">
        <aside className="planner-side">
          <PlansPanel plans={plans} selectedId={planId} onSelect={selectPlan}
                      onCreate={createPlan} onRename={renamePlan} onDelete={deletePlan} />
          {planId !== null && (
            <VersionsPanel versions={versions} openVersion={openVersion}
                           onOpen={(n) => run(() => openSaved(planId, n))} onCompare={compareVersions} />
          )}
        </aside>

        <div className="planner-main">
          <SettingsForm settings={settings} onChange={setSettings} boroughs={boroughs}
                        onPreview={doPreview} busy={busy} stale={stale} />

          {compare && <ComparePanel {...compare} onClose={() => setCompare(null)} />}

          {!scored ? <HowItWorks /> : (
            <div className="card">
              <div className="card-head">
                <div className="card-title">
                  Allocation{" "}
                  <span className="muted">{openVersion ? `· opened from v${openVersion}` : "· new proposal"}</span>
                </div>
                <button className="link" onClick={() => setEdits({})} disabled={Object.keys(edits).length === 0}>
                  Reset to proposal
                </button>
              </div>

              <div className="kpis">
                <div className="kpi"><span>{fleet}</span>taxis each hour</div>
                <div className="kpi"><span>{hours.length}</span>{hours.length === 1 ? "hour" : "hours"}</div>
                <div className="kpi"><span>{zonesUsed}</span>zones used</div>
                <div className="kpi"><span>{changed.length}</span>analyst edits</div>
                <div className={`kpi ${unbalanced.length ? "bad" : "good"}`}>
                  <span>{unbalanced.length ? unbalanced.length : "✓"}</span>
                  {unbalanced.length ? "hours to fix" : "all hours balanced"}
                </div>
              </div>

              <div className="hour-tabs">
                {hours.map((h) => {
                  const left = byHour[h].left;
                  return (
                    <button key={h} className={`hour-tab ${h === hour ? "active" : ""} ${left === 0 ? "ok" : "bad"}`}
                            onClick={() => { setHour(h); setFocusId(null); }}>
                      {hourLabel(h)}
                      <span className="badge">{left === 0 ? "✓" : left > 0 ? `${left} left` : `${-left} over`}</span>
                    </button>
                  );
                })}
              </div>

              {slot && (
                <div className="split planner-split">
                  <div>
                    {slot.rows.length === 0 ? (
                      <p className="muted">No zone is eligible at {hourLabel(hour)}.</p>
                    ) : slot.left !== 0 && (
                      <div className={`hint ${slot.left > 0 ? "" : "over"}`}>
                        <span>
                          {slot.left > 0
                            ? <><strong>{slot.left}</strong> {slot.left === 1 ? "taxi" : "taxis"} left to place at {hourLabel(hour)}</>
                            : <><strong>{-slot.left}</strong> too many at {hourLabel(hour)}</>}
                        </span>
                        <button onClick={() => balance(hour)}>
                          {slot.left > 0 ? `Give to #${slot.rows[0].rank}` : "Take from the lowest ranked"}
                        </button>
                      </div>
                    )}
                    <AllocationTable rows={slot.rows} candidates={slot.candidates} weights={scored.settings}
                                     focusId={focusId} onSet={setFinal} onAdd={addRow} onRemove={removeRow} />
                  </div>
                  <div className="map-col">
                    <ZoneMap values={mapValues} label="taxis" onZoneClick={onZoneClick} />
                    <div className="legend">
                      <span>fewer taxis</span><span className="ramp" /><span>more taxis</span>
                      <span className="muted">· grey: none placed</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {scored && <StoreCheck settings={scored.settings} />}

          {scored && (
            <div className="save-bar">
              <div className={`save-status ${blocker ? "" : "ready"}`}>
                {blocker ?? `Every hour adds up to ${fleet} taxis. Ready to save.`}
              </div>
              <input placeholder="Note for this version (optional)" value={note} maxLength={500}
                     onChange={(e) => setNote(e.target.value)} />
              <button className="primary" onClick={save} disabled={busy || blocker !== null}>
                {planId === null ? "Save" : `Save as v${nextVersion}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// Shown before the first preview: what the planner does and how it scores.
function HowItWorks() {
  return (
    <div className="card how">
      <div className="card-title">How the planner works</div>
      <ol className="steps">
        <li><strong>Score.</strong> For the chosen weekday and hours, every zone with enough pickups gets four
          percentiles within its hour, from all loaded months:</li>
      </ol>
      <div className="metric-grid">
        {METRICS.map((m) => (
          <div key={m.label} className="metric">
            <span className="dot" style={{ background: m.color }} /><strong>{m.label}</strong>
            <div className="muted small">{m.help}</div>
          </div>
        ))}
      </div>
      <ol className="steps" start={2}>
        <li><strong>Split.</strong> The weighted score picks the best zones each hour and divides the fleet in
          proportion (largest remainder), so every hour adds up exactly.</li>
        <li><strong>Adjust and save.</strong> Move taxis between zones or add others. Each save is a new version,
          written in one transaction; the database refuses any hour that doesn't add up to the fleet.</li>
      </ol>
    </div>
  );
}
