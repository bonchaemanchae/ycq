import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, del, patch, post, type Borough } from "../api";
import ZoneMap from "../components/ZoneMap";
import { useDetails } from "../details";
import FlowsPanel, { centreMap, flowLines } from "./flows/FlowsPanel";
import { bucketOfHour, toParams, type Centroid, type Query, type Slice, type Zone } from "./flows/types";
import { useApi } from "./flows/useApi";
import AllocationTable, { type TableRow } from "./planner/AllocationTable";
import ComparePanel from "./planner/ComparePanel";
import PlansPanel from "./planner/PlansPanel";
import SettingsForm from "./planner/SettingsForm";
import StoreCheck from "./planner/StoreCheck";
import WeekGrid, { useWeek } from "./planner/WeekGrid";
import WatchedZones from "./planner/WatchedZones";
import VersionsPanel from "./planner/VersionsPanel";
import {
  DEFAULT_WEIGHTS, busiestWithin, hourLabel, key, limitAllows, limitLabel, readLimit, toRequest,
  type Change, type Limit, type PlanSummary, type Preview, type Row, type SavedVersion, type Settings, type Shift,
  type VersionSummary,
} from "./planner/types";
import "./planner/planner.css";

// Allocation Planner. Backend routes are in api/routers/plans.py, scoring and
// saving in api/planner.py, rules in sql/006, sql/011 and sql/017.
//
// Two sections:
//   Build a plan   choose the shift -> Preview scores every eligible zone and
//                  splits the fleet -> adjust the final taxis (every hour must
//                  add up to the fleet) -> save it as a new version of a plan,
//                  in one transaction. Clicking a zone shows where its trips
//                  go (the Flow Explorer), to help decide where to move taxis.
//   Saved plans    rename or delete plans, open or compare their versions.

type Message = { kind: "error" | "ok"; text: string } | null;
type HourSlot = { rows: TableRow[]; candidates: Row[]; left: number };

const INITIAL: Settings = {
  fleet_size: 100, iso_dow: 1, start_hour: 7, end_hour: 9, borough_ids: [],
  max_zones_per_hour: 10, min_sample: 30, ...DEFAULT_WEIGHTS,
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export default function Planner() {
  const { tab: param } = useParams();
  const navigate = useNavigate();
  const tab = param === "saved" ? "saved" : "build";
  useEffect(() => {
    if (param !== tab) navigate(`/planner/${tab}`, { replace: true });
  }, [param, tab, navigate]);
  const details = useDetails();

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
  const [newPlanName, setNewPlanName] = useState("");
  const [flow, setFlow] = useState<Query | null>(null);
  // What the dashboard handed over: its boroughs, its weekday and hour filters
  // (the limit), the zones the analyst looked at, and the section to go back to.
  const [handoff, setHandoff] = useState<{ boroughs: string[]; back: "overview" | "trends"; limit: Limit | null } | null>(null);
  const [watched, setWatched] = useState<number[]>([]);
  // The shift to start on once the week has loaded: the one the dashboard
  // named, or the busiest inside its filters.
  const [pending, setPending] = useState<Shift | "busiest" | null>(null);

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

  const previewWith = (s: Settings) => run(async () => {
    const p = await score(s);
    setEdits({});
    setOpenVersion(null);
    if (p.empty_hours.length) {
      setMessage({ kind: "error", text:
        `No zone has ${s.min_sample}+ pickups at ${p.empty_hours.map(hourLabel).join(", ")}. ` +
        "Lower the minimum pickups (Advanced settings) or add boroughs." });
    }
  });
  const doPreview = () => previewWith(settings);

  // A shift chosen from the busiest shifts, or handed over by the dashboard:
  // set it and preview it straight away.
  const planShift = (shift: Shift, boroughIds?: number[], fleet?: number) => {
    const s = { ...settings, iso_dow: shift.dow, start_hour: shift.from, end_hour: shift.to,
                ...(boroughIds?.length ? { borough_ids: boroughIds } : {}),
                ...(fleet ? { fleet_size: fleet } : {}) };
    setSettings(s);
    previewWith(s);
  };

  // /planner/build?boroughs=Manhattan,Queens&days=2,3&hours=7-9&watch=132 (planLink
  // in planner/types.ts). Read once the boroughs are known, then cleared from the address.
  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    if (!boroughs.length || ![...search.keys()].length) return;
    const names = (search.get("boroughs") ?? "").split(",").filter(Boolean);
    const ids = boroughs.filter((b) => names.includes(b.name)).map((b) => b.borough_id);
    const dow = Number(search.get("dow")), from = Number(search.get("from")), to = Number(search.get("to"));
    const exact = search.has("from") && dow >= 1 && dow <= 7 && from >= 0 && to <= 23 && from <= to;
    const watch = (search.get("watch") ?? "").split(",").map(Number).filter((n) => n > 0);
    const back = ["trends", "timing"].includes(search.get("back") ?? "") ? "trends" : "overview";
    const limit = readLimit(search);
    setSearch({}, { replace: true });
    if (!ids.length) return;
    setWatched(watch);
    setSettings((x) => ({ ...x, borough_ids: ids }));
    setHandoff({ boroughs: names, back, limit });
    setPending(exact ? { dow, from, to } : "busiest");
  }, [boroughs, search]);

  // The week of the chosen boroughs, for the grid, the busiest shifts and the fleet estimate.
  const chosenNames = useMemo(
    () => boroughs.filter((b) => settings.borough_ids.includes(b.borough_id)).map((b) => b.name),
    [boroughs, settings.borough_ids]);
  const week = useWeek(chosenNames);
  const limit = handoff?.limit ?? null;
  const allow = useMemo(() => (limit ? limitAllows(limit) : undefined), [limit]);

  // Start on the handed-over shift as soon as the week is in, with the fleet
  // that keeps up with it, and score it.
  useEffect(() => {
    if (!pending || !week.ready) return;
    setPending(null);
    const shift = pending === "busiest" ? busiestWithin(week.grid, limit) : pending;
    if (shift) planShift(shift, undefined, week.fleetOf(shift) ?? undefined);
  }, [pending, week.ready]);   // eslint-disable-line react-hooks/exhaustive-deps

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
    setFlow(null);
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
    setMessage({ kind: "ok", text: `Created “${name}”. Build the plan, then save it as version 1.` });
    navigate("/planner/build");
  });

  // The plan the save bar saves to: an existing one, or a new one to create.
  const pickSaveTarget = (value: string) => run(async () => {
    if (value === "new") {
      setPlanId(null);
      setVersions([]);
      setOpenVersion(null);
      return;
    }
    const id = Number(value);
    setPlanId(id);
    setOpenVersion(null);
    await loadVersions(id);
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

  // The Flow Explorer for the zone in focus, at this plan's day type and the
  // time band of the hour being edited, in the latest month.
  const months = useApi<string[]>("/flows/months");
  const centroids = useApi<Centroid[]>("/zones/centroids");
  const latestMonth = months.data?.[months.data.length - 1];
  useEffect(() => {
    if (focusId === null || !scored || !latestMonth) return;
    setFlow((f) => ({
      originZoneId: focusId,
      month: latestMonth,
      dayType: f?.dayType ?? (scored.settings.iso_dow >= 6 ? "weekend" : "weekday"),
      timeBucket: bucketOfHour(hour),
    }));
  }, [focusId, hour, scored, latestMonth]);
  const slice = useApi<Slice>(flow && `/flows?${toParams(flow)}`);
  const centre = useMemo(() => centreMap(centroids.data), [centroids.data]);
  const lines = useMemo(() => flowLines(slice.data, centre), [slice.data, centre]);

  const slot = byHour[hour];
  const mapValues = Object.fromEntries((slot?.rows ?? []).filter((r) => r.final > 0).map((r) => [r.location_id, r.final]));
  const allRows = Object.values(byHour).flatMap((s) => s.rows);
  const changed = allRows.filter((r) => (r.added ? r.final > 0 : r.final !== r.proposed_taxis));
  const zonesUsed = new Set(allRows.filter((r) => r.final > 0).map((r) => r.location_id)).size;
  const unbalanced = hours.filter((h) => byHour[h].left !== 0);
  const nextVersion = (versions[0]?.version_no ?? 0) + 1;

  const blocker =
    planId === null && !newPlanName.trim() ? "Name the new plan, or choose one of your plans to save to." :
    stale ? "The settings changed since the preview. Preview again before saving." :
    unbalanced.length ? `${unbalanced.map(hourLabel).join(", ")} ${unbalanced.length > 1 ? "don't" : "doesn't"} add up to the fleet of ${fleet} yet.` :
    null;

  const save = () => run(async () => {
    if (!scored) return;
    let id = planId;
    let name = plans.find((p) => p.allocation_plan_id === id)?.name ?? "";
    if (id === null) {
      name = newPlanName.trim();
      id = (await post<{ allocation_plan_id: number }>("/plans", { name })).allocation_plan_id;
      setPlanId(id);
      setNewPlanName("");
    }
    const { version_no } = await post<{ version_no: number }>(`/plans/${id}/versions`, {
      settings: toRequest(scored.settings, note.trim() || undefined),
      edits: changed.map((r) => ({ hour: r.hour, location_id: r.location_id, final_taxis: r.final })),
    });
    await Promise.all([loadPlans(), loadVersions(id)]);
    setOpenVersion(version_no);
    setNote("");
    setMessage({ kind: "ok", text: `Saved as version ${version_no} of “${name}”. Saved versions are sealed and can't be changed.` });
  });
  const planName = plans.find((p) => p.allocation_plan_id === planId)?.name;

  const zones = useApi<Zone[]>("/zones");
  const zoneNames = useMemo(() => new Map((zones.data ?? []).map((z) => [z.location_id, z.zone_name])), [zones.data]);
  const backName = handoff?.back === "trends" ? "Daily trends" : "Zone maps";
  const fromDashboard = handoff && (
    <div className="handoff">
      <span>
        <strong>From {backName}:</strong>{" "}
        {[handoff.boroughs.length >= 6 ? "all boroughs" : handoff.boroughs.join(", "),
          watched.length ? `${watched.length} watched ${watched.length === 1 ? "zone" : "zones"}` : "",
          handoff.limit ? limitLabel(handoff.limit) : ""]
          .filter(Boolean).join(" · ")}
        {" · "}<strong>Plans use all of {week.months}</strong>
      </span>
      <Link to={`/dashboard/${handoff.back}`}>← Back to {backName}</Link>
      <button className="link" onClick={() => { setHandoff(null); setWatched([]); }} aria-label="Dismiss">✕</button>
    </div>
  );

  // The fleet that keeps up with the shift in the settings, with a button to use it.
  const shiftNow = { dow: settings.iso_dow, from: settings.start_hour, to: settings.end_hour };
  const suggested = week.ready && shiftNow.from <= shiftNow.to ? week.fleetOf(shiftNow) : null;
  const fleetHint = suggested !== null && (
    <>
      <span title="About how many taxis keep up with this shift: its pickups an hour times the average trip time, i.e. how many are busy with a passenger at once">
        Suggested ≈ {suggested.toLocaleString()}
      </span>
      {suggested !== settings.fleet_size && (
        <button type="button" className="link" onClick={() => setSettings({ ...settings, fleet_size: suggested })}>
          Use it
        </button>
      )}
    </>
  );

  const header = (
    <div className="page-head">
      <h1>{tab === "saved" ? "Saved plans" : "Build a plan"}</h1>
      <p className="muted">
        {tab === "saved"
          ? "Every save is a new version that can't be changed afterwards. Open a version to work from it, or compare two to see which zones gained or lost taxis."
          : "How many taxis to station in each zone, hour by hour. The planner scores zones on past pickups, shortages, steadiness and fares; you adjust and save. Plans come from historical trips, not live taxi positions."}
      </p>
    </div>
  );
  const alert = message && (
    <div className={`alert ${message.kind}`}>
      <span>{message.text}</span>
      <button className="link" onClick={() => setMessage(null)} aria-label="Dismiss">✕</button>
    </div>
  );

  if (tab === "saved") {
    return (
      <section className="planner">
        {header}
        {alert}
        <div className="saved-layout">
          <PlansPanel plans={plans} selectedId={planId} onSelect={selectPlan}
                      onCreate={createPlan} onRename={renamePlan} onDelete={deletePlan} />
          <div>
            {planId === null ? (
              <div className="card"><p className="muted">Choose a plan to see its versions.</p></div>
            ) : (
              <VersionsPanel versions={versions} openVersion={openVersion}
                             onOpen={(n) => run(async () => {
                               await openSaved(planId, n);
                               navigate("/planner/build");
                             })}
                             onCompare={compareVersions} />
            )}
            {compare && <ComparePanel {...compare} onClose={() => setCompare(null)} />}
          </div>
        </div>
      </section>
    );
  }

  const focusName = flow && (slot?.rows.find((r) => r.location_id === flow.originZoneId)?.zone_name
    ?? slot?.candidates.find((r) => r.location_id === flow.originZoneId)?.zone_name
    ?? `zone ${flow.originZoneId}`);

  return (
    <section className="planner">
      {header}
      {fromDashboard}
      {alert}

      <SettingsForm settings={settings} onChange={setSettings} boroughs={boroughs}
                    onPreview={doPreview} busy={busy} stale={stale} fleetHint={fleetHint}
                    suggestions={
                      <WeekGrid week={week} hasBoroughs={chosenNames.length > 0} current={shiftNow} allow={allow}
                                onChoose={(shift) => planShift(shift)} />
                    } />

      {scored && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">
              2. Check and adjust each hour{" "}
              <div className="card-sub">
                {openVersion ? `Opened from version ${openVersion} of “${planName}”.` : "A new proposal."} Click a
                zone name or the map to see where its trips go.
              </div>
            </div>
            <button className="link" onClick={() => setEdits({})} disabled={Object.keys(edits).length === 0}>
              Reset to proposal
            </button>
          </div>

          <div className={`plan-status ${unbalanced.length ? "bad" : "good"}`}>
            <span>{zonesUsed} {zonesUsed === 1 ? "zone" : "zones"} used</span>
            <span>{changed.length} {changed.length === 1 ? "edit" : "edits"}</span>
            <strong>
              {unbalanced.length
                ? `${unbalanced.length} ${unbalanced.length === 1 ? "hour doesn't" : "hours don't"} add up to ${fleet} yet`
                : `every hour adds up to ${fleet} taxis`}
            </strong>
          </div>

          <div className="hour-tabs">
            {hours.map((h) => {
              const left = byHour[h].left;
              return (
                <button key={h} className={`hour-tab ${h === hour ? "active" : ""} ${left === 0 ? "ok" : "bad"}`}
                        onClick={() => setHour(h)}>
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
                <WatchedZones watched={watched} names={zoneNames} hour={hour} rows={slot.rows}
                              candidates={slot.candidates} weights={scored.settings}
                              onFocus={(id) => setFocusId(id)} onAdd={addRow} />
                <AllocationTable rows={slot.rows} candidates={slot.candidates} weights={scored.settings} watched={watched}
                                 focusId={focusId} onSet={setFinal} onAdd={addRow} onRemove={removeRow}
                                 onFocus={(r) => setFocusId(r.location_id)} />
              </div>
              <div className="map-col">
                <ZoneMap values={mapValues} label="taxis" onZoneClick={onZoneClick} selectedId={focusId} markedIds={watched}
                         lines={flow ? lines : undefined} />
                <div className="legend">
                  <span>fewer taxis</span><span className="ramp" /><span>more taxis</span>
                  <span className="muted">· grey: none placed</span>
                </div>
                {flow && months.data && (
                  <div className="planner-flows">
                    <FlowsPanel query={flow} onChange={setFlow} months={months.data} slice={slice} compact
                                originName={focusName ?? ""}
                                onClose={() => { setFlow(null); setFocusId(null); }}
                                note={<>Taxis that pick up here end up in these zones. Latest month, matched to
                                  this plan's day and the {hourLabel(hour)} hour.</>} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {scored && details.on && <StoreCheck settings={scored.settings} />}

      {scored && (
        <div className="save-bar">
          <span className="save-label">3. Save to</span>
          <select value={planId ?? "new"} onChange={(e) => pickSaveTarget(e.target.value)} aria-label="Plan to save to">
            <option value="new">A new plan…</option>
            {plans.map((p) => <option key={p.allocation_plan_id} value={p.allocation_plan_id}>{p.name}</option>)}
          </select>
          {planId === null && (
            <input placeholder="New plan name" value={newPlanName} maxLength={100}
                   onChange={(e) => setNewPlanName(e.target.value)} />
          )}
          <input placeholder="Note for this version (optional)" value={note} maxLength={500}
                 onChange={(e) => setNote(e.target.value)} />
          <button className="primary" onClick={save} disabled={busy || blocker !== null}>
            {planId === null ? "Save as version 1" : `Save as v${nextVersion}`}
          </button>
          <div className={`save-status ${blocker ? "" : "ready"}`}>
            {blocker ?? `Every hour adds up to ${fleet} taxis. Ready to save.`}
          </div>
        </div>
      )}
    </section>
  );
}
