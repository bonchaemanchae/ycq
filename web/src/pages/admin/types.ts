// Shapes returned by api/routers/admin.py, and helpers shared by the
// Administration page.

export type Reason = { code: string; description: string; rows: number };

export type ImportBatch = {
  import_batch_id: number;
  month: string;
  source_file: string;
  checksum_prefix: string;
  rows_read: number;
  rows_accepted: number;
  rows_rejected: number;
  rows_warned: number;
  status: string;
  finished_at: string | null;
  rejects: Reason[];
  warnings: Reason[];
};

export type RejectedRow = {
  source_row_number: number;
  code: string;
  vendor_id: string | null;
  pickup_ts: string | null;
  dropoff_ts: string | null;
  pickup_location_id: string | null;
  dropoff_location_id: string | null;
  payment_type_id: string | null;
  passenger_count: string | null;
  trip_distance: string | null;
  fare_amount: string | null;
  total_amount: string | null;
};

export type RejectedPage = { total: number; page: number; pages: number; rows: RejectedRow[] };

export type ReconRun = {
  reconciliation_run_id: number;
  month: string;
  finished_at: string | null;
  passed: boolean | null;
  pg_hour_rows: number | null;
  mongo_hour_docs: number | null;
  pg_pickups: number | null;
  mongo_pickups: number | null;
  pg_dropoffs: number | null;
  mongo_dropoffs: number | null;
  zone_hour_mismatches: number | null;
  od_mismatches: number | null;
  details: unknown;
};

// Plain-English names for the import rules, for readers without the rule
// table. The database's own description is shown on hover.
export const PLAIN: Record<string, string> = {
  R1: "Pickup or drop-off time missing",
  R2: "Drop-off recorded before pickup",
  R3: "Trip belongs to a different month",
  R4: "Pickup location unknown",
  R5: "File already imported",
  R6: "Trip longer than 24 hours",
  R7: "Refund entry that duplicates a real trip",
  R8: "Unknown vendor, payment or rate code",
  R9: "Impossible value (such as negative passengers)",
  W1: "Distance missing or zero",
  W2: "Fare zero or negative",
  W3: "Distance over 100 miles",
  W4: "Fare over $500",
  W5: "Trip over 6 hours",
  W6: "Drop-off location unknown",
  W7: "Voided trip",
  W8: "Impossibly fast (over 80 mph)",
  W9: "Drop-off time not recorded",
};

export const n = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString());

export const when = (v: string | null) => (v ? new Date(v).toLocaleString() : "–");

// Trip times are New York local time with no time zone, so they are shown as stored.
export const local = (v: string | null) => (v ? v.replace("T", " ") : "–");

export const pct = (part: number, whole: number) => {
  if (!whole) return "–";
  const p = (100 * part) / whole;
  return part > 0 && p < 0.01 ? "<0.01%" : `${p.toFixed(2)}%`;
};

// The newest reconciliation run for each month (runs arrive newest first).
export function latestRuns(runs: ReconRun[]): Map<string, ReconRun> {
  const latest = new Map<string, ReconRun>();
  for (const r of runs) if (!latest.has(r.month)) latest.set(r.month, r);
  return latest;
}

export type BenchmarkResult = {
  store: "postgres" | "mongo_collection" | "mongo_timeseries";
  query_name: string;
  runs: number;
  cold_ms: number;
  median_ms: number;
  p95_ms: number;
  storage_bytes: number | null;
  index_bytes: number | null;
  load_ms: number | null;
  plan_output: string | null;
  data: "hourly" | "destinations";   // Q1-Q4 use hourly summaries, Q5 destination lists
};

export type BenchmarkRun = { run_at: string | null; results: BenchmarkResult[] };

export const STORE_LABEL: Record<BenchmarkResult["store"], string> = {
  postgres: "PostgreSQL",
  mongo_collection: "MongoDB collection",
  mongo_timeseries: "MongoDB time-series",
};

export const ms = (v: number) => (v < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`);

export const mb = (bytes: number | null) => (bytes == null ? "–" : `${(bytes / 1_048_576).toFixed(1)} MB`);
