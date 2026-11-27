// Shapes returned by api/routers/admin.py, and helpers for the
// Administration pages.

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

export const n = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString());

// Short and 24-hour, like the rest of the app: "15 Oct 2026, 23:25".
export const when = (v: string | null) =>
  (v ? new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit",
                                             minute: "2-digit", hour12: false }) : "–");

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
