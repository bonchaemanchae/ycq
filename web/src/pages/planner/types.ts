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
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
