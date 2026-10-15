import { useEffect, useState } from "react";
import { post } from "../../api";
import { toRequest, type Settings } from "./types";

type Timing = { first_ms: number; median_ms: number };
type Result = {
  zone_hours: number;
  values_compared: number;
  fields: string[];
  mismatch_count: number;
  mismatches: { location_id: number; hour: number; fields: string[] }[];
  runs: number;
  postgres: Timing;
  mongodb: Timing;
  postgres_sql: string;
  mongodb_pipeline: unknown;
};

// SQL vs NoSQL: the statistics behind this preview, computed again from
// MongoDB's time-series collection, compared value by value and timed.
export default function StoreCheck({ settings }: { settings: Settings }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setResult(null); setError(""); }, [settings]);

  const check = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await post<Result>("/plans/compare-stores", toRequest(settings)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const faster = result && (result.postgres.median_ms <= result.mongodb.median_ms ? "PostgreSQL" : "MongoDB");

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">PostgreSQL vs MongoDB</div>
        <button onClick={check} disabled={busy}>{busy ? "Checking…" : result ? "Run again" : "Check against MongoDB"}</button>
      </div>
      <p className="muted small">
        The scores above use per-zone, per-hour statistics (days, pickups, average pickups, net outflow and
        standard deviation) from PostgreSQL. This computes the same statistics from MongoDB’s hourly time-series
        collection with <code>$match</code>, <code>$group</code>, <code>$avg</code> and <code>$stdDevPop</code>,
        and compares every value. Median fares stay in PostgreSQL: a median can’t be rebuilt from hourly sums.
      </p>
      {error && <div className="alert error">{error}</div>}
      {result && (
        <>
          <div className="kpis">
            <div className={`kpi ${result.mismatch_count ? "bad" : "good"}`}>
              <span>{result.mismatch_count ? result.mismatch_count : "✓"}</span>
              {result.mismatch_count ? "zone-hours differ" : `all ${result.values_compared.toLocaleString()} values identical`}
            </div>
            <div className="kpi"><span>{result.zone_hours}</span>zone-hours compared</div>
            <div className="kpi"><span>{result.postgres.median_ms} ms</span>PostgreSQL (median of {result.runs})</div>
            <div className="kpi"><span>{result.mongodb.median_ms} ms</span>MongoDB (median of {result.runs})</div>
          </div>
          <p className="small muted">
            {faster} was faster on this query. First runs: PostgreSQL {result.postgres.first_ms} ms, MongoDB{" "}
            {result.mongodb.first_ms} ms (a first run can be slower while data is read into memory).
          </p>
          {result.mismatches.length > 0 && (
            <ul className="small">
              {result.mismatches.map((m) => (
                <li key={`${m.hour}:${m.location_id}`}>zone {m.location_id}, hour {m.hour}: {m.fields.join(", ")}</li>
              ))}
            </ul>
          )}
          <details className="queries">
            <summary className="small">Show both queries</summary>
            <div className="split">
              <div><div className="small muted">PostgreSQL</div><pre className="example">{result.postgres_sql}</pre></div>
              <div><div className="small muted">MongoDB</div>
                <pre className="example">{JSON.stringify(result.mongodb_pipeline, null, 2)}</pre></div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
