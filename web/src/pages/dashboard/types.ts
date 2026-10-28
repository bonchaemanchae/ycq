// Shapes returned by api/routers/dashboard.py, and helpers for the Activity
// Dashboard. Filter names match a saved view's filters (api/saved_views.py).

export type Metric = "pickups" | "dropoffs" | "imbalance";

export type Filters = {
  dateFrom: string;
  dateTo: string;
  weekdays: number[];          // empty = every day
  hourFrom: number | null;     // null = from midnight
  hourTo: number | null;       // null = to 23:00; hourFrom > hourTo wraps past midnight
  boroughs: string[];          // empty = every borough
  metric: Metric;
};

export const METRICS: { value: Metric; label: string; help: string }[] = [
  { value: "pickups", label: "Pickups", help: "trips starting in the zone" },
  { value: "dropoffs", label: "Drop-offs", help: "trips ending in the zone" },
  { value: "imbalance", label: "Imbalance", help: "pickups minus drop-offs" },
];

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // ISO 1-7

// GET /dashboard
export type Totals = {
  pickups: number;
  dropoffs: number;
  days: number;
  zones: number;
  pickupsPerDay: number | null;
  averageFare: number | null;
  averageDistance: number | null;
  averageDurationSec: number | null;
};

export type ZoneRow = {
  zoneId: number;
  zoneName: string;
  borough: string;
  pickups: number;
  dropoffs: number;
  imbalance: number;
  pickupRank: number;
  dropoffRank: number;
  pickupShare: number | null;
  dropoffShare: number | null;
  averageFare: number | null;
  averageDistance: number | null;
  averageDurationSec: number | null;
};

// Every activity answer says which MongoDB collection it was read from and
// how long the query took (api/routers/dashboard.py).
export type Answered = { source: string; queryMs: number };

export const SOURCE_LABEL: Record<string, string> = {
  zone_activity_timeseries: "hourly zone data",
  zone_activity_daily: "daily zone summary",
  borough_activity_hourly: "hourly borough summary",
};

export type Summary = Answered & { totals: Totals; zones: ZoneRow[] };

// GET /dashboard/series
export type Point = {
  localDate: string;
  localHour?: number;
  pickups: number;
  dropoffs: number;
  movingAveragePickups: number;
  movingAverageDropoffs: number;
  averageFare: number | null;
};
export type Series = Answered & { bucket: "hour" | "day"; window: number; points: Point[] };

// GET /dashboard/weekdays
export type WeekdayRow = {
  isoDayOfWeek: number;
  days: number;
  pickups: number;
  dropoffs: number;
  averagePickups: number;
  averageDropoffs: number;
};
export type GridCell = { isoDayOfWeek: number; hour: number; averagePickups: number };
export type Weekdays = Answered & { weekdays: WeekdayRow[]; grid: GridCell[] };

// GET /dashboard/compare
export type CompareZone = {
  zoneId: number;
  zoneName: string;
  found: boolean;
  borough?: string;
  hours?: number;
  pickups?: number;
  dropoffs?: number;
  imbalance?: number;
  meanPickupsPerHour?: number;
  medianPickupsPerHour?: number;
  p90PickupsPerHour?: number;
  maxPickupsPerHour?: number;
  peakHour?: number | null;
  peakHourAveragePickups?: number | null;
  averageFare?: number | null;
  averageDistance?: number | null;
  averageDurationSec?: number | null;
};
export type Compare = Answered & { zones: CompareZone[] };

// GET /dashboard/context
export type Context = {
  dateFrom: string | null;
  dateTo: string | null;
  latestImport: { month: string; rows_accepted: number; finished_at: string } | null;
  recentPlans: {
    allocation_plan_id: number;
    name: string;
    updated_at: string;
    latest_version: number | null;
    fleet_size: number | null;
    iso_dow: number | null;
    start_hour: number | null;
    end_hour: number | null;
  }[];
};

// Query string for the activity routes. Lists repeat their name
// (weekdays=1&weekdays=2); unset filters are left out.
export function toQuery(f: Filters, extra: Record<string, string | number | number[]> = {}) {
  const p = new URLSearchParams();
  if (f.dateFrom) p.set("dateFrom", f.dateFrom);
  if (f.dateTo) p.set("dateTo", f.dateTo);
  f.weekdays.forEach((d) => p.append("weekdays", String(d)));
  if (f.hourFrom !== null) p.set("hourFrom", String(f.hourFrom));
  if (f.hourTo !== null) p.set("hourTo", String(f.hourTo));
  f.boroughs.forEach((b) => p.append("boroughs", b));
  p.set("metric", f.metric);
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.set(k, String(v));
  }
  return p.toString();
}

const NA = "n/a";
export const count = (v: number | null | undefined) => (v === null || v === undefined ? NA : v.toLocaleString());
export const signed = (v: number) => (v > 0 ? `+${v.toLocaleString()}` : v.toLocaleString());
export const percent = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(1)}%`);
export const money = (v: number | null | undefined) => (v === null || v === undefined ? NA : `$${v.toFixed(2)}`);
export const miles = (v: number | null | undefined) => (v === null || v === undefined ? NA : `${v.toFixed(2)} mi`);
export const minutes = (sec: number | null | undefined) =>
  sec === null || sec === undefined ? NA : `${(sec / 60).toFixed(1)} min`;
export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
export const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// --- saved views (components/SavedViews.tsx) ---------------------------------------
// A saved view keeps only the filters that are set, under the same names
// (api/filters.py); empty lists and unset hours are left out.

export function toSaved(f: Filters): Record<string, unknown> {
  return {
    dateFrom: f.dateFrom,
    dateTo: f.dateTo,
    ...(f.weekdays.length ? { weekdays: f.weekdays } : {}),
    ...(f.hourFrom !== null ? { hourFrom: f.hourFrom } : {}),
    ...(f.hourTo !== null ? { hourTo: f.hourTo } : {}),
    ...(f.boroughs.length ? { boroughs: f.boroughs } : {}),
    metric: f.metric,
  };
}

// Back to the page's filters. A missing date means the loaded data's first or
// last day.
export function fromSaved(s: Record<string, unknown>, bounds: { dateFrom: string; dateTo: string }): Filters {
  return {
    dateFrom: (s.dateFrom as string) ?? bounds.dateFrom,
    dateTo: (s.dateTo as string) ?? bounds.dateTo,
    weekdays: (s.weekdays as number[]) ?? [],
    hourFrom: (s.hourFrom as number) ?? null,
    hourTo: (s.hourTo as number) ?? null,
    boroughs: (s.boroughs as string[]) ?? [],
    metric: (s.metric as Metric) ?? "pickups",
  };
}

// One line describing a saved view, e.g. "1 Mar to 31 Mar · Mon Tue · 07:00 to 09:59 · Manhattan · Pickups".
export function describeSaved(s: Record<string, unknown>): string {
  const f = fromSaved(s, { dateFrom: "start", dateTo: "end" });
  const date = (d: string) => (d === "start" || d === "end" ? d : dayLabel(d));
  return [
    `${date(f.dateFrom)} to ${date(f.dateTo)}`,
    f.weekdays.length ? f.weekdays.map((d) => WEEKDAYS[d - 1]).join(" ") : "every day",
    f.hourFrom !== null || f.hourTo !== null
      ? `${hourLabel(f.hourFrom ?? 0)} to ${String(f.hourTo ?? 23).padStart(2, "0")}:59` : "all hours",
    f.boroughs.length ? f.boroughs.join(", ") : "all boroughs",
    METRICS.find((m) => m.value === f.metric)!.label,
  ].join(" · ");
}
