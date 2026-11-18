// Shapes returned by api/routers/flows.py and api/routers/zones.py, and
// helpers shared by the Flow Explorer.

export type DayType = "weekday" | "weekend";
export type TimeBucket = "night" | "am_peak" | "midday" | "pm_peak" | "evening";

export const DAY_TYPES: { value: DayType; label: string }[] = [
  { value: "weekday", label: "Weekday (Mon-Fri)" },
  { value: "weekend", label: "Weekend (Sat-Sun)" },
];

// Local pickup hour, as time_bucket_of() in sql/005_summaries.sql.
export const TIME_BUCKETS: { value: TimeBucket; label: string; hours: string }[] = [
  { value: "night", label: "Night", hours: "00:00-05:59" },
  { value: "am_peak", label: "AM Peak", hours: "06:00-09:59" },
  { value: "midday", label: "Midday", hours: "10:00-15:59" },
  { value: "pm_peak", label: "PM Peak", hours: "16:00-19:59" },
  { value: "evening", label: "Evening", hours: "20:00-23:59" },
];

export type Query = { originZoneId: number; month: string; dayType: DayType; timeBucket: TimeBucket };

// GET /zones and GET /zones/centroids
export type Zone = { location_id: number; zone_name: string; service_zone: string | null; borough: string };
export type Centroid = { location_id: number; lat: number; lon: number };

// GET /flows
export type Destination = {
  rank: number;
  zoneId: number;
  zoneName: string;
  borough: string;
  trips: number;
  share: number;                       // 0..1 of all the origin's trips in the slice
  averageFare: number | null;
  averageDistance: number | null;      // miles
  averageDurationSec: number | null;
};

export type Slice = Query & {
  found: boolean;
  originBorough: string | null;
  totalTrips: number;
  destinationCount: number;
  topTrips: number;
  topShare: number | null;
  destinations: Destination[];
};

// GET /flows/compare-months
export type MonthHeader = {
  month: string;
  found: boolean;
  totalTrips?: number;
  destinationCount?: number;
  complete?: boolean;                  // the month's list holds every destination
};

export type MonthEntry = { rank: number; trips: number; share: number };

export type CompareDestination = {
  zoneId: number;
  zoneName: string;
  borough: string;
  monthsInTop10: number;
  listedTrips: number;
  byMonth: Record<string, MonthEntry | null>;
};

export type Compare = {
  basis: string;
  months: MonthHeader[];
  destinations: CompareDestination[];
};

// The time band a local hour falls in (same bands as TIME_BUCKETS).
export const bucketOfHour = (h: number): TimeBucket =>
  h < 6 ? "night" : h < 10 ? "am_peak" : h < 16 ? "midday" : h < 20 ? "pm_peak" : "evening";

// The band that covers most of these hours (the first one on a tie).
export function bucketForHours(hours: number[]): TimeBucket {
  const counts = new Map<TimeBucket, number>();
  for (const h of hours) counts.set(bucketOfHour(h), (counts.get(bucketOfHour(h)) ?? 0) + 1);
  let best: TimeBucket = bucketOfHour(hours[0] ?? 8);
  for (const t of TIME_BUCKETS) if ((counts.get(t.value) ?? 0) > (counts.get(best) ?? 0)) best = t.value;
  return best;
}

export const toParams = (q: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();

export const bucketLabel = (b: TimeBucket) => {
  const t = TIME_BUCKETS.find((x) => x.value === b)!;
  return `${t.label} ${t.hours}`;
};

export const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

const NA = "n/a";
export const count = (v: number) => v.toLocaleString();
export const percent = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(1)}%`);
export const money = (v: number | null) => (v === null ? NA : `$${v.toFixed(2)}`);
export const miles = (v: number | null) => (v === null ? NA : `${v.toFixed(2)} mi`);
export const minutes = (sec: number | null) => (sec === null ? NA : `${(sec / 60).toFixed(1)} min`);
