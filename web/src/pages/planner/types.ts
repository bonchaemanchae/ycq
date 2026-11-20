// Shapes returned by api/routers/plans.py, and helpers shared by the planner.

// One scored zone for one hour (POST /plans/preview).
export type Row = {
  hour: number;
  location_id: number;
  zone_name: string;
  borough: string;
  rank: number;
  score: number;
  sample_size: number;
  selected: boolean;
  reliable: boolean;      // enough pickups that hour to be recommended (min_sample)
  proposed_taxis: number;
  days: number;
  avg_pickups: number;
  avg_imbalance: number;
  median_fare: number | null;
  pct_pickup: number;
  pct_imbalance: number;
  pct_consistency: number;
  pct_fare: number;
  reason: string;
};

export type Preview = { allocations: Row[]; candidates: Row[]; empty_hours: number[] };

export type PlanSummary = {
  allocation_plan_id: number;
  name: string;
  updated_at: string;
  latest_version: number | null;
  fleet_size: number | null;
  iso_dow: number | null;
  start_hour: number | null;
  end_hour: number | null;
  total_taxis: number;
  zones_covered: number;
};

export type VersionSummary = {
  version_no: number;
  created_at: string;
  fleet_size: number;
  iso_dow: number;
  start_hour: number;
  end_hour: number;
  note: string | null;
  zones_used: number;
  edited_rows: number;
  hash: string | null;          // SHA-256 seal, chained to the version before (sql/017)
  seal_problem: string | null;  // null when the version still matches its seal
};

export type SavedVersion = {
  name: string;
  version_no: number;
  fleet_size: number;
  iso_dow: number;
  start_hour: number;
  end_hour: number;
  max_zones_per_hour: number;
  min_sample: number;
  w_pickup: number;
  w_imbalance: number;
  w_consistency: number;
  w_fare: number;
  note: string | null;
  borough_ids: number[];
  results: { hour: number; location_id: number; final_taxis: number }[];
};

export type Change = {
  hour: number;
  location_id: number;
  zone_name: string;
  borough: string;
  taxis_before: number;
  taxis_after: number;
  change: number;
};

export type Settings = {
  fleet_size: number;
  iso_dow: number;
  start_hour: number;
  end_hour: number;
  borough_ids: number[];
  max_zones_per_hour: number;
  min_sample: number;
  w_pickup: number;
  w_imbalance: number;
  w_consistency: number;
  w_fare: number;
};

export const DEFAULT_WEIGHTS = { w_pickup: 0.5, w_imbalance: 0.25, w_consistency: 0.15, w_fare: 0.1 };

// The four scoring metrics, in the order of the score bar.
export const METRICS = [
  { weight: "w_pickup", pct: "pct_pickup", label: "Pickup activity", color: "#e0a800",
    help: "Average pickups in that zone and hour" },
  { weight: "w_imbalance", pct: "pct_imbalance", label: "Net outflow", color: "#2f6fdb",
    help: "Pickups minus drop-offs: taxis leave faster than they arrive" },
  { weight: "w_consistency", pct: "pct_consistency", label: "Consistency", color: "#1e9e6a",
    help: "How steady pickups are from day to day" },
  { weight: "w_fare", pct: "pct_fare", label: "Median fare", color: "#9b51c9",
    help: "Median metered fare for that zone, weekday and hour" },
] as const;

// Why the settings can't be scored yet, first problem first (empty when they can).
export function settingsProblems(s: Settings): string[] {
  const sum = weightSum(s);
  return [
    s.fleet_size < 1 && "The fleet needs at least 1 taxi",
    s.start_hour > s.end_hour && "The shift has to end after it starts",
    s.borough_ids.length === 0 && "Pick at least one borough",
    sum !== 1 && `The ranking weights add up to ${sum.toFixed(2)}, not 1`,
  ].filter(Boolean) as string[];
}

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export const key = (hour: number, locationId: number) => `${hour}:${locationId}`;

export const weightSum = (s: Settings) =>
  Math.round((s.w_pickup + s.w_imbalance + s.w_consistency + s.w_fare) * 1000) / 1000;

// Settings as the API expects them; weights go as strings so they stay exact decimals.
export const toRequest = (s: Settings, note?: string) => ({
  ...s,
  w_pickup: s.w_pickup.toFixed(3),
  w_imbalance: s.w_imbalance.toFixed(3),
  w_consistency: s.w_consistency.toFixed(3),
  w_fare: s.w_fare.toFixed(3),
  ...(note ? { note } : {}),
});

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

// --- handing the dashboard's view to the planner ------------------------------
// The dashboard's Allocate button opens the planner with a link:
//   /planner/build?boroughs=Manhattan,Queens&days=2,3,4&hours=7-9&watch=132,186&back=overview
// `days` and `hours` are the dashboard's weekday and hour filters: the planner
// greys out the rest of its week and starts on the busiest shift inside them.
// When the filters name exactly one shift (one weekday, one hour range) it comes
// as dow/from/to and the planner starts on that. `watch` lists the zones the
// analyst looked at (opened or compared), which the planner highlights and
// offers to add; `back` is the dashboard section to return to.

export type Shift = { dow: number; from: number; to: number };

// The weekdays and hours a handoff narrows the week to (hours may wrap past
// midnight, e.g. 22 to 2). An empty `days` means every weekday; null hours, all 24.
export type Limit = { days: number[]; from: number | null; to: number | null };

export function limitAllows(l: Limit | null): (dow: number, hour: number) => boolean {
  if (!l) return () => true;
  const from = l.from ?? 0, to = l.to ?? 23;
  const hourOk = (h: number) => (from <= to ? h >= from && h <= to : h >= from || h <= to);
  return (dow, h) => (l.days.length === 0 || l.days.includes(dow)) && hourOk(h);
}

export function planLink(shift: Shift | null, boroughs: string[], watch: number[] = [], back?: string,
                         limit?: Limit): string {
  const p = new URLSearchParams();
  if (shift) {
    p.set("dow", String(shift.dow));
    p.set("from", String(shift.from));
    p.set("to", String(shift.to));
  }
  if (boroughs.length) p.set("boroughs", boroughs.join(","));
  if (limit?.days.length) p.set("days", limit.days.join(","));
  if (limit && (limit.from !== null || limit.to !== null)) p.set("hours", `${limit.from ?? 0}-${limit.to ?? 23}`);
  if (watch.length) p.set("watch", watch.join(","));
  if (back) p.set("back", back);
  return `/planner/build?${p.toString()}`;
}

// Reads days= and hours= back; null when neither is there or they don't parse.
export function readLimit(search: URLSearchParams): Limit | null {
  const days = (search.get("days") ?? "").split(",").map(Number).filter((d) => d >= 1 && d <= 7);
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(search.get("hours") ?? "");
  const from = m && Number(m[1]) <= 23 ? Number(m[1]) : null;
  const to = m && Number(m[2]) <= 23 ? Number(m[2]) : null;
  if (!days.length && (from === null || to === null)) return null;
  return { days, from: to === null ? null : from, to: from === null ? null : to };
}

// The busiest `count` shifts of `length` hours, none overlapping, from a
// weekday x hour grid of average pickups (GET /dashboard/weekdays). `allow`
// limits them to some weekdays and hours: every hour of a shift must be allowed.
// `pickups` is the shift's pickups on an average day.
export type RankedShift = Shift & { pickups: number };
export function busiestShifts(grid: { isoDayOfWeek: number; hour: number; averagePickups: number }[],
                              count: number, length = 3,
                              allow: (dow: number, hour: number) => boolean = () => true): RankedShift[] {
  const cell = new Map(grid.map((g) => [`${g.isoDayOfWeek}:${g.hour}`, g.averagePickups]));
  const windows: RankedShift[] = [];
  for (let dow = 1; dow <= 7; dow++) {
    for (let from = 0; from + length <= 24; from++) {
      if (!Array.from({ length }, (_, i) => from + i).every((h) => allow(dow, h))) continue;
      let pickups = 0;
      for (let h = from; h < from + length; h++) pickups += cell.get(`${dow}:${h}`) ?? 0;
      windows.push({ dow, from, to: from + length - 1, pickups });
    }
  }
  windows.sort((a, b) => b.pickups - a.pickups);
  const chosen: RankedShift[] = [];
  for (const w of windows) {
    if (w.pickups <= 0 || chosen.length === count) break;
    if (!chosen.some((x) => x.dow === w.dow && x.from <= w.to && w.from <= x.to)) chosen.push(w);
  }
  return chosen;
}

// About how many taxis keep up with demand: pickups an hour times the average
// trip time, i.e. how many are busy with a passenger at once. Rounded to 5.
export function fleetFor(pickupsPerHour: number, tripSec: number | null | undefined): number | null {
  if (!tripSec || pickupsPerHour <= 0) return null;
  return Math.max(1, Math.round((pickupsPerHour * tripSec) / 3600 / 5) * 5);
}

// The end of a shift whose last hour is `to`: 19 ends at 20:00, 23 at midnight.
export const endLabel = (to: number) => (to === 23 ? "midnight" : hourLabel(to + 1));

// --- why a zone was chosen ----------------------------------------------------------
// The two strongest parts of its score in words, e.g. "Short of taxis (top 5%)
// · Busy (top 10%)", plus a warning when its demand is uneven week to week.
// Percentiles are within the hour, among the eligible zones.

const TOP = [[0.95, "top 5%"], [0.9, "top 10%"], [0.75, "top 25%"]] as const;
const WHY: Record<string, string> = {
  pct_pickup: "Busy", pct_imbalance: "Short of taxis", pct_consistency: "Steady", pct_fare: "High fares",
};

// The reasons worth pointing out on a zone's row. Being busy and short of taxis
// is why nearly every zone is in the plan, so that isn't repeated; what's
// shown is what sets a zone apart, or a risk.
export type Note = { text: string; kind: "plain" | "warn" | "muted"; help: string };
export function notableNotes(row: Row): Note[] {
  if (!row.reliable) {
    return [{ text: "Few trips", kind: "muted",
              help: "Too few pickups at this hour to recommend; it's in the plan because you added it." }];
  }
  const out: Note[] = [];
  if (row.pct_fare >= 0.9) {
    out.push({ text: "High fares", kind: "plain", help: "Trips from here pay more than almost anywhere else at this hour." });
  }
  if (row.pct_consistency >= 0.9) {
    out.push({ text: "Steady", kind: "plain",
               help: "About as busy every week at this hour, so taxis sent here reliably find passengers." });
  }
  if (row.pct_consistency < 0.25) {
    out.push({ text: "Uneven week to week", kind: "warn",
               help: "Busy on average, but some weeks are much quieter at this hour: a riskier place for many taxis." });
  }
  return out;
}

export function whyLine(row: Row, weights: Settings): string {
  const parts = METRICS
    .map((m) => ({ pct: row[m.pct], weighted: row[m.pct] * weights[m.weight], name: WHY[m.pct] }))
    .filter((m) => m.pct >= 0.75)
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, 2)
    .map((m) => `${m.name} (${TOP.find(([t]) => m.pct >= t)![1]})`);
  if (row.pct_consistency < 0.25) parts.push("Uneven week to week");
  return parts.length ? parts.join(", ") : "Good all round";
}
