import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, del, patch, post, type Borough } from "../api";
import ZoneMap from "../components/ZoneMap";
import { useDetails } from "../details";
import { type Zone } from "./flows/types";
import { useApi } from "./flows/useApi";
import ComparePanel from "./planner/ComparePanel";
import PlanTable, { type HourSlot, type TableRow } from "./planner/PlanTable";
import PlansPanel from "./planner/PlansPanel";
import SaveDialog from "./planner/SaveDialog";
import SettingsForm from "./planner/SettingsForm";
import StoreCheck from "./planner/StoreCheck";
import VersionsPanel from "./planner/VersionsPanel";
import { busiestAllowed, useWeek } from "./planner/useWeek";
import {
  DAYS, DEFAULT_WEIGHTS, fleetFor, hourLabel, hourRanges, key, limitAllows, readLimit, settingsProblems,
  toRequest,
  type Change, type Limit, type PlanSummary, type Preview, type Row, type SavedVersion, type Settings, type Shift,
  type VersionSummary,
} from "./planner/types";
import "./planner/planner.css";

// Allocation Planner. Backend routes are in api/routers/plans.py, scoring and
// saving in api/planner.py, rules in sql/006, sql/011 and sql/017.
//
// Two sections:
//   Build a plan   1. choose the shift, the taxis and the boroughs; every
//                  change works the plan out again (POST /plans/preview): the
//                  top zones each hour, taxis split by score x pickups.
//                  2. check it: a zone per row, an hour per column, any number
//                  can be changed, and every hour must add up to the fleet.
//                  Save plan stores it as a new version, in one transaction.
//                  Clicking a zone highlights it on the map, and the other way round.
//   Saved plans    rename or delete plans, open or compare their versions.

type Message = { kind: "error" | "ok"; text: string } | null;

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
  // The saved version loaded in the planner: which plan, and which version of it.
  const [opened, setOpened] = useState<{ planId: number; version: number } | null>(null);

  const [settings, setSettings] = useState<Settings>(INITIAL);
  // The plan and the settings it was worked out with. Saving always uses these.
  const [scored, setScored] = useState<{ settings: Settings; preview: Preview } | null>(null);
  // Final taxis the analyst changed, by "hour:location_id".
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [hour, setHour] = useState(INITIAL.start_hour);      // the hour the map shows
  const [focusId, setFocusId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [compare, setCompare] = useState<{
    from: VersionSummary; to: VersionSummary; a: SavedVersion; b: SavedVersion; changes: Change[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [newPlanName, setNewPlanName] = useState("");
  const [saving, setSaving] = useState(false);               // the save dialog is open
  // a confirmation (saved, created) fades out after a few seconds
  useEffect(() => {
    if (message?.kind !== "ok") return;
    const t = setTimeout(() => setMessage(null), 3500);
    return () => clearTimeout(t);
  }, [message]);
  // why the zone just clicked on the map can't be planned; clears itself
  // A zone clicked on the map that isn't in the plan: what it is, and a button
  // that adds that zone (and its borough first, when the plan doesn't cover it).
  const [zoneNote, setZoneNote] = useState<
    { text: string; zoneId: number; zoneName: string; borough: Borough | null; canAdd: boolean } | null>(null);
  // A zone waiting for its borough's plan to come back before it's added.
  const [pendingZone, setPendingZone] = useState<{ id: number; name: string; borough: string } | null>(null);
  // Keep typed numbers through the next new plan (adding a borough re-ranks it).
  const keepEdits = useRef(false);
  // The zone just added: its row is scrolled to and its first box focused.
  const [justAdded, setJustAdded] = useState<{ id: number; n: number } | null>(null);
  useEffect(() => {
    if (!zoneNote) return;
    const t = setTimeout(() => setZoneNote(null), 8000);
    return () => clearTimeout(t);
  }, [zoneNote]);
  // What the dashboard handed over: its boroughs, its weekday and hour filters
  // (the limit), the zones the analyst looked at, and the section to go back to.
  const [handoff, setHandoff] = useState<{ boroughs: string[]; back: "overview" | "trends"; limit: Limit | null } | null>(null);
  const [watched, setWatched] = useState<number[]>([]);
  // The shift to start on once the week has loaded: the one the dashboard
  // named, or the busiest (inside its filters, if it sent any).
  const [pending, setPending] = useState<Shift | "busiest" | null>(null);
  // The taxis box holds the planner's estimate (how many the shift's demand
  // needs) until the manager types their own fleet; then it's theirs and never
  // changes by itself. Clearing the box goes back to the estimate.
  const [fleetTyped, setFleetTyped] = useState(false);

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
      // The whole city by default, like the dashboard; a link from the
      // dashboard narrows it to the boroughs filtered there (below).
      setSettings((s) => ({ ...s, borough_ids: s.borough_ids.length ? s.borough_ids : b.map((x) => x.borough_id) }));
      await loadPlans();
    });
  }, []);

  // --- working the plan out -----------------------------------------------------

  // The settings last sent to be scored, so an older answer arriving late is ignored.
  const requested = useRef("");
  const score = async (s: Settings) => {
    const k = JSON.stringify(s);
    requested.current = k;
    const preview = await post<Preview>("/plans/preview", toRequest(s));
    if (requested.current !== k) return null;
    setScored({ settings: s, preview });
    setHour((h) => (h >= s.start_hour && h <= s.end_hour ? h : s.start_hour));
    return preview;
  };

  const previewWith = (s: Settings) => run(async () => {
    const keep = keepEdits.current;
    keepEdits.current = false;
    const lost = keep ? 0 : Object.keys(edits).length;
    const before = edits;
    const p = await score(s);
    if (!p) return;
    if (keep) {
      const still = new Set([...p.allocations, ...p.candidates].map((r) => key(r.hour, r.location_id)));
      setEdits(Object.fromEntries(Object.entries(before).filter(([k]) => still.has(k))));
    } else {
      setEdits({});
    }
    setOpened(null);
    setFocusId(null);
    // When no hour has a recommendation, the plan card says so instead (below).
    if (p.empty_hours.length && p.empty_hours.length < s.end_hour - s.start_hour + 1) {
      setMessage({ kind: "error", text:
        `No zone has enough trips to recommend at ${hourRanges(p.empty_hours)}, ` +
        "so type taxis into a zone yourself or add boroughs" });
    } else if (lost) {
      setMessage({ kind: "ok", text:
        `Plan updated, ${lost} ${lost === 1 ? "change" : "changes"} cleared` });
    }
  });

  // Any change to the settings works the plan out again, a moment after the last one.
  useEffect(() => {
    if (!boroughs.length || pending) return;
    if (JSON.stringify(settings) === requested.current || settingsProblems(settings).length) return;
    const t = setTimeout(() => previewWith(settings), 250);
    return () => clearTimeout(t);
  }, [settings, boroughs.length, pending]);   // eslint-disable-line react-hooks/exhaustive-deps

  // /planner/build?boroughs=Manhattan,Queens&days=2,3&hours=7-9&watch=132 (planLink
  // in planner/types.ts). Read once the boroughs are known, then cleared from
  // the address. Without one, the planner starts on the busiest shift.
  const [search, setSearch] = useSearchParams();
  const started = useRef(false);
  useEffect(() => {
    if (!boroughs.length) return;
    const fresh = !started.current;
    started.current = true;
    if (![...search.keys()].length) {
      if (fresh) setPending("busiest");
      return;
    }
    const names = (search.get("boroughs") ?? "").split(",").filter(Boolean);
    const ids = boroughs.filter((b) => names.includes(b.name)).map((b) => b.borough_id);
    const dow = Number(search.get("dow")), from = Number(search.get("from")), to = Number(search.get("to"));
    const exact = search.has("from") && dow >= 1 && dow <= 7 && from >= 0 && to <= 23 && from <= to;
    const watch = (search.get("watch") ?? "").split(",").map(Number).filter((n) => n > 0);
    const back = ["trends", "timing"].includes(search.get("back") ?? "") ? "trends" : "overview";
    const limit = readLimit(search);
    setSearch({}, { replace: true });
    if (!ids.length) {
      if (fresh) setPending("busiest");
      return;
    }
    setWatched(watch);
    setSettings((x) => ({ ...x, borough_ids: ids }));
    setHandoff({ boroughs: names, back, limit });
    setPending(exact ? { dow, from, to } : "busiest");
  }, [boroughs, search]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The week of the chosen boroughs: the busiest shift to start on, and the average trip time.
  const chosenNames = useMemo(
    () => boroughs.filter((b) => settings.borough_ids.includes(b.borough_id)).map((b) => b.name),
    [boroughs, settings.borough_ids]);
  const week = useWeek(chosenNames);
  const limit = handoff?.limit ?? null;
  const allow = useMemo(() => (limit ? limitAllows(limit) : undefined), [limit]);

  // Start on the pending shift as soon as the week is in.
  useEffect(() => {
    if (!pending) return;
    if (week.error) {
      setPending(null);
      return;
    }
    if (!week.ready) return;
    const shift = pending === "busiest" ? busiestAllowed(week.grid, 1, allow)[0] : pending;
    setPending(null);
    if (shift) {
      setSettings((s) => ({ ...s, iso_dow: shift.dow, start_hour: shift.from, end_hour: shift.to }));
    }
  }, [pending, week.ready, week.error]);   // eslint-disable-line react-hooks/exhaustive-deps

  // About how many taxis keep up with the zones in this plan: their pickups an
  // hour at the plan's busiest hour, times the average trip time.
  const demand = useMemo(() => {
    if (!scored) return null;
    const perHour = new Map<number, number>();
    for (const r of scored.preview.allocations) perHour.set(r.hour, (perHour.get(r.hour) ?? 0) + Number(r.avg_pickups));
    let peak = Math.max(0, ...perHour.values());
    // No zone recommended: estimate from the boroughs' own pickups on this
    // shift instead, so the box never shows a made-up number.
    if (peak === 0) {
      const { iso_dow, start_hour, end_hour } = scored.settings;
      peak = Math.max(0, ...week.grid.filter((g) => g.isoDayOfWeek === iso_dow && g.hour >= start_hour && g.hour <= end_hour)
        .map((g) => g.averagePickups));
    }
    return { peak, fleet: fleetFor(peak, week.tripSec) };
  }, [scored, week.tripSec, week.grid]);
  const suggested = demand?.fleet ?? null;
  // While the box is on the estimate, follow it as the shift or the area changes.
  useEffect(() => {
    if (fleetTyped || suggested === null) return;
    // an automatic re-estimate isn't the manager's change: keep what they typed or added
    if (settings.fleet_size !== suggested) keepEdits.current = true;
    setSettings((s) => (s.fleet_size === suggested ? s : { ...s, fleet_size: suggested }));
  }, [suggested, fleetTyped]);
  const setFleet = (n: number | null) => {
    if (n === null) return setFleetTyped(false);          // emptied: back to the estimate
    setFleetTyped(true);
    setSettings((s) => ({ ...s, fleet_size: n }));
  };

  // Loads a saved version: its settings, a fresh score, and its final taxis as edits.
  const openSaved = async (id: number, versionNo: number) => {
    setPending(null);
    setFleetTyped(true);                                     // a saved fleet was a real decision
    const v = await api<SavedVersion>(`/plans/${id}/versions/${versionNo}`);
    const s: Settings = {
      fleet_size: v.fleet_size, iso_dow: v.iso_dow, start_hour: v.start_hour, end_hour: v.end_hour,
      borough_ids: v.borough_ids, max_zones_per_hour: v.max_zones_per_hour, min_sample: v.min_sample,
      w_pickup: Number(v.w_pickup), w_imbalance: Number(v.w_imbalance),
      w_consistency: Number(v.w_consistency), w_fare: Number(v.w_fare),
    };
    setSettings(s);
    const p = await score(s);
    if (!p) return;
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
    setOpened({ planId: id, version: versionNo });
    setNote("");
    setFocusId(null);
  };

  // --- plans (CRUD) ----------------------------------------------------------

  // Picking a plan lists its versions; a version is loaded only when opened.
  const selectPlan = (id: number) => run(async () => {
    setPlanId(id);
    setCompare(null);
    await loadVersions(id);
  });
  // Saved plans opens on the most recently changed plan (the list comes newest
  // first), with its versions, rather than on an empty panel.
  useEffect(() => {
    if (tab === "saved" && planId === null && plans.length > 0) selectPlan(plans[0].allocation_plan_id);
  }, [tab, planId, plans]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The plan the dialog saves to: an existing one, or a new one to create.
  const pickSaveTarget = (value: string) => run(async () => {
    if (value === "new") {
      setPlanId(null);
      setVersions([]);
      return;
    }
    const id = Number(value);
    setPlanId(id);
    await loadVersions(id);
  });

  const renamePlan = (id: number, name: string) => run(async () => {
    await patch(`/plans/${id}`, { name });
    await loadPlans();
  });

  const deletePlan = (id: number) => run(async () => {
    await del(`/plans/${id}`);
    if (opened?.planId === id) setOpened(null);
    if (id === planId) {
      setPlanId(null);
      setVersions([]);
      setCompare(null);
    }
    await loadPlans();
  });

  // The older version always on the left, whichever order they were picked in.
  const compareVersions = (x: number, y: number) => run(async () => {
    const [from, to] = x < y ? [x, y] : [y, x];
    const [changes, a, b] = await Promise.all([
      api<Change[]>(`/plans/${planId}/compare?from_version=${from}&to_version=${to}`),
      api<SavedVersion>(`/plans/${planId}/versions/${from}`),
      api<SavedVersion>(`/plans/${planId}/versions/${to}`),
    ]);
    setCompare({
      from: versions.find((v) => v.version_no === from)!,
      to: versions.find((v) => v.version_no === to)!,
      a, b, changes,
    });
  });

  // --- the plan being edited ------------------------------------------------------

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
    else if (!row.selected && taxis === 0 && !(k in edits)) return;   // 0 typed into an empty cell
    else next[k] = taxis;
    setEdits(next);
  };

  // Adds a zone to every hour of the shift where it's eligible, with no taxis
  // yet, then shows it: highlighted, the map zoomed to it, its row scrolled to
  // and its first box ready for typing.
  const addZone = (id: number, note?: string) => {
    const next = { ...edits };
    let name = "";
    for (const h of hours) {
      const c = byHour[h].candidates.find((x) => x.location_id === id);
      if (c) {
        next[key(h, id)] ??= 0;
        name = c.zone_name;
      }
    }
    setEdits(next);
    setFocusId(id);
    setZoomTo((z) => ({ id, n: (z?.n ?? 0) + 1 }));
    setJustAdded((a) => ({ id, n: (a?.n ?? 0) + 1 }));
    if (name) setMessage({ kind: "ok", text: `Added ${name}: type its taxis${note ? `. ${note}` : ""}` });
  };
  useEffect(() => {
    if (!justAdded) return;
    const box = document.querySelector<HTMLInputElement>(`#zone-row-${justAdded.id} .cell input`);
    box?.scrollIntoView({ block: "center", behavior: "smooth" });
    box?.focus({ preventScroll: true });
  }, [justAdded]);

  // The note's button: add the zone, adding its borough first when needed.
  const addFromNote = () => {
    if (!zoneNote?.canAdd) return;
    const { zoneId, zoneName, borough } = zoneNote;
    setZoneNote(null);
    if (!borough) return addZone(zoneId);
    keepEdits.current = true;
    setPendingZone({ id: zoneId, name: zoneName, borough: borough.name });
    setSettings((x) => ({ ...x, borough_ids: [...new Set([...x.borough_ids, borough.borough_id])] }));
  };
  // Once the plan with the new borough is in, add the zone that was clicked.
  useEffect(() => {
    if (!pendingZone || !scored || stale) return;
    if (!scored.preview.candidates.some((r) => r.location_id === pendingZone.id)
        && !scored.preview.allocations.some((r) => r.location_id === pendingZone.id)) return;
    const { id, borough } = pendingZone;
    setPendingZone(null);
    if (Object.values(byHour).some((slot) => slot.rows.some((r) => r.location_id === id))) {
      // the new borough's ranking already put it in the plan
      setFocusId(id);
      setZoomTo((z) => ({ id, n: (z?.n ?? 0) + 1 }));
      setJustAdded((a) => ({ id, n: (a?.n ?? 0) + 1 }));
      setMessage({ kind: "ok", text: `${pendingZone.name} is in the plan. ${borough} added, so its zones are ranked too` });
    } else {
      addZone(id, `${borough} added, so its zones are ranked too`);
    }
  }, [scored, stale, pendingZone]);   // eslint-disable-line react-hooks/exhaustive-deps

  const removeZone = (id: number) => {
    const next = { ...edits };
    for (const h of hours) {
      const r = byHour[h].rows.find((x) => x.location_id === id);
      if (r?.added) delete next[key(h, id)];
    }
    setEdits(next);
    // it was shown on the map: let it go and zoom back out
    setFocusId(null);
    setResetView((n) => n + 1);
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

  // Clicking a zone on the map: if it's in the plan, show it; if not, a note
  // offers to add it (and its borough, when needed). Nothing is added by a click alone.
  const zoneClick = useRef<(id: number) => void>(() => {});
  zoneClick.current = (id: number) => {
    if (!scored) return;
    // already in the plan at some hour: just show it
    if (Object.values(byHour).some((slot) => slot.rows.some((r) => r.location_id === id))) return setFocusId(id);
    const z = zones.data?.find((x) => x.location_id === id);
    const name = z?.zone_name ?? `Zone ${id}`;
    if (Object.values(byHour).some((slot) => slot.candidates.some((r) => r.location_id === id))) {
      return setZoneNote({ text: `${name} isn't in this plan.`, zoneId: id, zoneName: name, borough: null, canAdd: true });
    }
    const borough = z ? boroughs.find((b) => b.name === z.borough) ?? null : null;
    setZoneNote(borough && !scored.settings.borough_ids.includes(borough.borough_id)
      ? { text: `${name} is in ${borough.name}, which isn't in this plan.`, zoneId: id, zoneName: name, borough, canAdd: true }
      : { text: `${name} can't be planned: it has no map shape.`, zoneId: id, zoneName: name, borough: null, canAdd: false });
  };
  const onZoneClick = useCallback((id: number) => zoneClick.current(id), []);
  // A zone's name clicked in the table: highlight it and zoom the map to it.
  // (Clicking on the map only highlights, so the view doesn't jump.)
  const [zoomTo, setZoomTo] = useState<{ id: number; n: number } | null>(null);
  // Undo my changes: the proposal back, nothing highlighted, the map back on the whole city.
  const [resetView, setResetView] = useState(0);
  // "Place taxis myself" on a plan with nothing recommended; a new area asks again
  const [manualAnyway, setManualAnyway] = useState(false);
  useEffect(() => setManualAnyway(false), [settings.borough_ids.join(",")]);   // eslint-disable-line react-hooks/exhaustive-deps
  const undoAll = () => {
    setEdits({});
    setFocusId(null);
    setResetView((n) => n + 1);
  };
  // Clicking the highlighted zone's name again lets it go and zooms back out.
  const focusFromTable = (id: number) => {
    if (id === focusId) {
      setFocusId(null);
      setResetView((n) => n + 1);
      return;
    }
    setFocusId(id);
    setZoomTo((z) => ({ id, n: (z?.n ?? 0) + 1 }));
  };


  const slot = byHour[hour];
  const mapValues = Object.fromEntries((slot?.rows ?? []).filter((r) => r.final > 0).map((r) => [r.location_id, r.final]));
  const allRows = Object.values(byHour).flatMap((s) => s.rows);
  const changed = allRows.filter((r) => (r.added ? r.final > 0 : r.final !== r.proposed_taxis));
  const unbalanced = hours.filter((h) => byHour[h].left !== 0);
  const nextVersion = (versions[0]?.version_no ?? 0) + 1;


  // what stops the plan from being saved, then what the dialog still needs
  const planBlocker =
    stale ? "The plan is still updating for the new settings." :
    unbalanced.length ? `${unbalanced.map(hourLabel).join(", ")} ${unbalanced.length > 1 ? "don't" : "doesn't"} add up to ${fleet.toLocaleString()} taxis yet.` :
    null;
  const blocker = planBlocker ?? (planId === null && !newPlanName.trim() ? "Give the new plan a name." : null);

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
    setOpened({ planId: id!, version: version_no });
    setNote("");
    setSaving(false);
    setMessage({ kind: "ok", text: `Saved as v${version_no} of “${name}”` });
  });
  const planName = plans.find((p) => p.allocation_plan_id === planId)?.name;

  const zones = useApi<Zone[]>("/zones");
  const zoneNames = useMemo(() => new Map((zones.data ?? []).map((z) => [z.location_id, z.zone_name])), [zones.data]);
  const backName = handoff?.back === "trends" ? "Daily trends" : "Zone maps";
  // Back to the dashboard section the analyst came from (its boroughs, hours
  // and watched zones came over and show in the filters and the table).
  const backLink = handoff && (
    <Link className="back-link" to={`/dashboard/${handoff.back}`}>← Back to {backName}</Link>
  );

  // How many taxis each hour's demand needs, as information (the fleet is what
  // the manager has): the plan's zones' pickups that hour times the average trip.
  const need = useMemo(() => {
    const out: Record<number, number | null> = {};
    if (!scored) return out;
    for (const h of hours) {
      const pickups = scored.preview.allocations.filter((r) => r.hour === h).reduce((n, r) => n + Number(r.avg_pickups), 0);
      out[h] = fleetFor(pickups, week.tripSec);
    }
    return out;
  }, [scored, week.tripSec]);   // eslint-disable-line react-hooks/exhaustive-deps
  const shortHours = hours.filter((h) => need[h] !== null && need[h]! > fleet);
  // the busiest hour's demand: the one number the fleet is compared with
  const peakHour = hours.reduce<number | null>((best, h) => (need[h] !== null && (best === null || need[h]! > need[best]!) ? h : best), null);
  const peak = peakHour === null ? null : { taxis: need[peakHour]!, hour: hourLabel(peakHour) };

  const header = tab === "saved" ? (
    <div className="page-head">
      <h1>Saved plans</h1>
    </div>
  ) : (
    <div className="page-head">
      {backLink}
      <h1>Build a plan</h1>
    </div>
  );
  // Errors stay on the page until dismissed; confirmations are a toast in the
  // top corner that goes away by itself.
  const alert = message && (message.kind === "error" ? (
    <div className="alert error">
      <span>{message.text}</span>
      <button className="link" onClick={() => setMessage(null)} aria-label="Dismiss">✕</button>
    </div>
  ) : (
    <div className="toast" role="status" key={message.text}>
      <span className="toast-tick" aria-hidden="true">✓</span>
      <span>{message.text}</span>
    </div>
  ));

  if (tab === "saved") {
    return (
      <section className="planner">
        {header}
        {alert}
        <div className="saved-layout">
          <PlansPanel plans={plans} selectedId={planId} onSelect={selectPlan}
                      onRename={renamePlan} onDelete={deletePlan} />
          <div>
            {planId === null ? (
              <div className="card"><p className="muted">Choose a plan to see its versions.</p></div>
            ) : (
              <VersionsPanel planName={plans.find((p) => p.allocation_plan_id === planId)?.name ?? "Versions"}
                             versions={versions} openVersion={opened && opened.planId === planId ? opened.version : null}
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

  // one status beside Save: can't be saved yet, saved but short of demand, or ready
  // Beside Save, only what stops it: hours that don't add up. Hours short of
  // demand are marked on their column in the table.
  const byLeft = new Map<number, number[]>();
  for (const h of unbalanced) byLeft.set(byHour[h].left, [...(byLeft.get(byHour[h].left) ?? []), h]);
  const warnings = [
    unbalanced.length > 0 && { kind: "bad", text: [...byLeft].map(([left, hs]) => {
      const n = Math.abs(left), taxis = n === 1 ? "taxi" : "taxis";
      return `${n} ${left > 0 ? `${taxis} not placed` : `extra ${taxis}`} at ${hourRanges(hs)}`;
    }).join(", ") },
  ].filter(Boolean) as { kind: string; text: string }[];
  // No zone recommended in any hour of the shift (too few trips in these
  // boroughs): one plain explanation instead of an empty table.
  const nothing = !!scored && !manualAnyway && changed.length === 0
    && scored.preview.empty_hours.length === hours.length;
  const allChosen = boroughs.length > 0 && chosenNames.length === boroughs.length;
  const area = allChosen ? "these boroughs" : chosenNames.length > 2
    ? `${chosenNames.slice(0, -1).join(", ")} and ${chosenNames[chosenNames.length - 1]}` : chosenNames.join(" and ");
  const perDay = scored ? Math.round(week.grid.filter((g) => g.isoDayOfWeek === scored.settings.iso_dow)
    .reduce((n, g) => n + g.averagePickups, 0)) : 0;
  // The busiest zones over the whole period that the plan can take (zones of
  // the chosen boroughs), and starting the plan with them: the fleet split
  // between them by those pickups, the same way the planner splits it.
  const takeable = new Set((scored?.preview.candidates ?? []).map((c) => c.location_id));
  const startZones = week.topZones.filter((z) => takeable.has(z.id));
  const startWithBusiest = () => {
    const total = startZones.reduce((n, z) => n + z.pickups, 0);
    const exact = startZones.map((z) => (fleet * z.pickups) / total);
    const split = exact.map(Math.floor);
    // largest remainder: the taxis left over go to the zones closest to the next one
    exact.map((x, i) => ({ i, rest: x - split[i] })).sort((a, b) => b.rest - a.rest)
      .slice(0, fleet - split.reduce((n, x) => n + x, 0)).forEach(({ i }) => { split[i] += 1; });
    const next: Record<string, number> = {};
    for (const h of hours) startZones.forEach((z, i) => { next[key(h, z.id)] = split[i]; });
    setEdits(next);
    setManualAnyway(true);
    setMessage({ kind: "ok", text: `Started with ${startZones.length} busiest zones, adjust the taxis as you need` });
  };
  const days = scored?.preview.allocations[0]?.days ?? null;

  return (
    <section className="planner">
      {header}
      {alert}

      <SettingsForm settings={settings} onChange={setSettings} boroughs={boroughs}
                    fleetIsEstimate={!fleetTyped} onFleet={setFleet} peak={peak}
                    updating={busy || stale || pending !== null} details={details.on} />

      {!scored ? (
        <div className="card"><p className="muted">{week.error || "Working out the plan for the busiest shift…"}</p></div>
      ) : nothing ? (
        <div className={`card plan-empty ${stale ? "plan-stale" : ""}`}>
          <span className="plan-empty-icon" aria-hidden="true">!</span>
          <h2>Not enough yellow-cab trips in {area} to recommend zones by the hour</h2>
          <p>
            About {perDay.toLocaleString()} {perDay === 1 ? "pickup" : "pickups"} on an average {DAYS[scored.settings.iso_dow - 1]}{" "}
            across {allChosen ? "the city" : area}, so no zone reaches {scored.settings.min_sample} pickups in any hour of
            this shift
          </p>
          {startZones.length > 0 && (
            <div className="plan-empty-zones">
              <span className="plan-empty-label">Busiest zones over {week.months}, every day and hour</span>
              <ol>
                {startZones.map((z) => (
                  <li key={z.id}><strong>{z.name}</strong> <span className="muted">{z.pickups.toLocaleString()} pickups</span></li>
                ))}
              </ol>
            </div>
          )}
          <div className="plan-empty-actions">
            {startZones.length > 0 && (
              <button className="primary" onClick={startWithBusiest}>Start the plan with these zones</button>
            )}
            {!allChosen && (
              <button className={startZones.length ? "" : "primary"}
                      onClick={() => setSettings((x) => ({ ...x, borough_ids: boroughs.map((b) => b.borough_id) }))}>
                Plan for all boroughs
              </button>
            )}
            <button className="link" onClick={() => setManualAnyway(true)}>Place taxis myself</button>
          </div>
        </div>
      ) : (
        <div className={`card ${stale ? "plan-stale" : ""}`}>
          <div className="plan-head">
            <h2 className="plan-title">
              Your plan
            </h2>
            {/* where the numbers come from, always in view */}
            <span className="muted small plan-source">
              Based on {days ? `${days} ${DAYS[scored.settings.iso_dow - 1]}s` : `every ${DAYS[scored.settings.iso_dow - 1]}`} of
              past trips ({week.months}), not live taxi positions
            </span>
            {opened && <span className="muted small">from version {opened.version} of “{plans.find((x) => x.allocation_plan_id === opened.planId)?.name ?? "a deleted plan"}”</span>}
            <span className="plan-actions-right">
              {changed.length > 0 && (
                <button className="link" onClick={undoAll}>
                  Undo my {changed.length} {changed.length === 1 ? "change" : "changes"}
                </button>
              )}
              {warnings.map((w) => <span key={w.text} className={`status-chip ${w.kind}`}>{w.text}</span>)}
              <button className="primary" onClick={() => setSaving(true)} disabled={busy || planBlocker !== null}>
                Save plan
              </button>
            </span>
          </div>

          {zoneNote && (
            <div className="zone-note" role="status">
              <span className="zone-note-icon" aria-hidden="true">⚠</span>
              <span className="zone-note-text">{zoneNote.text}</span>
              {zoneNote.canAdd && (
                <button className="zone-note-add" onClick={addFromNote}>
                  Add {zoneNote.zoneName}
                  {zoneNote.borough && <span className="zone-note-sub"> (adds {zoneNote.borough.name})</span>}
                </button>
              )}
              <button className="link zone-note-x" onClick={() => setZoneNote(null)} aria-label="Dismiss">✕</button>
            </div>
          )}

          <div className="split planner-split">
            <PlanTable hours={hours} byHour={byHour} weights={scored.settings} fleet={fleet} watched={watched}
                       names={zoneNames} focusId={focusId} mapHour={hour} onSet={setFinal} onAddZone={(id) => addZone(id)}
                       onRemoveZone={removeZone} onBalance={balance} onFocus={focusFromTable} onMapHour={setHour}
                       need={need} details={details.on} />
            <div className="map-col">
              <label className="map-hour">
                <span>Map shows</span>
                <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {hours.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
              </label>
              <ZoneMap values={mapValues} label="taxis" onZoneClick={onZoneClick} selectedId={focusId} markedIds={watched}
                       zoomTo={zoomTo} resetView={resetView} home={allChosen ? undefined : chosenNames} />
              <div className="legend">
                <span>fewer taxis</span><span className="ramp" /><span>more taxis</span>
                <span className="muted legend-gap">grey: none placed</span>
                <span className="legend-outline outline-selected" aria-hidden="true" /><span className="muted">selected</span>
                {watched.length > 0 && <><span className="legend-outline outline-watched" aria-hidden="true" /><span className="muted">watched</span></>}
              </div>
            </div>
          </div>

        </div>
      )}

      {scored && details.on && <StoreCheck settings={scored.settings} />}

      {saving && (
        <SaveDialog plans={plans} planId={planId} onPickPlan={pickSaveTarget} newName={newPlanName}
                    onNewName={setNewPlanName} note={note} onNote={setNote} nextVersion={nextVersion}
                    blocker={blocker} error={message?.kind === "error" ? message.text : null}
                    busy={busy} onSave={save} onClose={() => setSaving(false)} />
      )}
    </section>
  );
}
