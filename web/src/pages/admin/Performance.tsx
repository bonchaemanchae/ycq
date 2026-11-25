import { useEffect, useState } from "react";
import { api } from "../../api";
import Proves from "./Proves";
import { STORE_LABEL, mb, ms, when, type BenchmarkResult, type BenchmarkRun, type LoadTestResult, type LoadTestRun } from "./types";

type Store = BenchmarkResult["store"];
type Data = BenchmarkResult["data"];

const STORES: Store[] = ["postgres", "mongo_collection", "mongo_timeseries", "mongo_summary"];
// Which database answers each load-tested question (etl/load_test.py).
const SERVED_BY: Record<string, string> = {
  "Flow Explorer": "MongoDB", "Map, daily summary": "MongoDB", "Map, hourly data": "MongoDB",
  "Weekday chart": "MongoDB", "Planner preview": "PostgreSQL",
};

const total = (r: BenchmarkResult | undefined) =>
  r && r.storage_bytes != null && r.index_bytes != null ? r.storage_bytes + r.index_bytes : null;
const times = (a: number, b: number) => `${(a / b).toFixed(a / b < 10 ? 1 : 0)}×`;
const seconds = (v: number | null) => (v == null ? "–" : `${(v / 1000).toFixed(1)} s`);
const num = (v: number | string | null) => (v == null ? null : Number(v));
// Response times under load: milliseconds, or seconds once past one
const wait = (v: number | string | null) => {
  const x = num(v) ?? 0;
  return x >= 1000 ? `${(x / 1000).toFixed(1)} s` : ms(x);
};

// Speed and size for each kind of data, measured in every store it could
// live in, then throughput under load. Each number appears once; the exact
// timings, sizes and query plans are folded away at the bottom.
export default function Performance({ run }: { run: BenchmarkRun }) {
  const [load, setLoad] = useState<LoadTestRun | null>(null);
  const [plan, setPlan] = useState<BenchmarkResult | null>(null);
  useEffect(() => {
    api<LoadTestRun>("/admin/load-tests").then(setLoad).catch(() => setLoad({ run_at: null, results: [] }));
  }, []);

  if (run.results.length === 0) {
    return (
      <div className="card">
        <div className="card-title">No benchmark yet</div>
        <p className="muted">Run <code>docker compose run --rm loader python etl/benchmark.py</code> and reload this page</p>
      </div>
    );
  }

  const res = run.results;
  const queries = [...new Set(res.map((r) => r.query_name))];
  const resultsFor = (q: string) =>
    STORES.map((s) => res.find((r) => r.store === s && r.query_name === q)).filter((r): r is BenchmarkResult => !!r);
  const ofData = (d: Data) => queries.filter((q) => res.find((r) => r.query_name === q)?.data === d);
  const one = (d: Data, s: Store, q?: string) => res.find((r) => r.data === d && r.store === s && (!q || r.query_name === q));
  const sizesOf = (d: Data) => STORES.flatMap((st) => {
    const rows = res.filter((r) => r.data === d && r.store === st);
    return st === "mongo_summary" ? rows : rows.slice(0, 1);
  });

  const pgHourly = total(one("hourly", "postgres")), tsHourly = total(one("hourly", "mongo_timeseries"));
  const pgDest = total(one("destinations", "postgres")), mgDest = total(one("destinations", "mongo_collection"));
  const speedups = ofData("dashboard").map((q) => {
    const pg = one("dashboard", "postgres", q), sum = one("dashboard", "mongo_summary", q);
    return pg && sum ? pg.median_ms / sum.median_ms : null;
  }).filter((x): x is number => x != null);
  const destMax = Math.max(...ofData("destinations").flatMap((q) => resultsFor(q).map((r) => r.median_ms)));
  const pgLoad = one("hourly", "postgres")?.load_ms ?? null, tsLoad = one("hourly", "mongo_timeseries")?.load_ms ?? null;
  const loadCost = pgLoad && tsLoad && tsLoad > pgLoad
    ? `, but takes ${times(tsLoad, pgLoad)} as long to load (${seconds(tsLoad)} against ${seconds(pgLoad)})` : "";
  // how steady the timings were: the worst 95th percentile against its median
  const spread = Math.max(...res.map((r) => r.p95_ms / r.median_ms));

  const sections: { id: string; data: Data; title: string; answer: string; takeaway: string; proves: string }[] = [
    {
      id: "hourly", data: "hourly", title: "Hourly zone summaries", answer: "Stored in MongoDB time-series",
      takeaway: `${pgHourly && tsHourly ? times(pgHourly, tsHourly) : "Much"} smaller than in PostgreSQL and fastest for the top 10 zones${loadCost}`,
      proves: "a storage choice backed by measurement",
    },
    {
      id: "destinations", data: "destinations", title: "Top 10 destinations per zone", answer: "Stored in MongoDB",
      takeaway: `${pgDest && mgDest ? times(pgDest, mgDest) : "Much"} smaller because each document keeps only the top 10, and both answer in ${destMax < 1 ? "under a millisecond" : ms(destMax)}`,
      proves: "a document model shaped by the question it answers",
    },
    {
      id: "dashboard", data: "dashboard", title: "Dashboard totals", answer: "Read from pre-summed MongoDB collections",
      takeaway: speedups.length
        ? `${times(Math.min(...speedups), 1)} to ${times(Math.max(...speedups), 1)} faster than PostgreSQL, for a few megabytes of extra storage`
        : "Pre-summed documents against PostgreSQL",
      proves: "pre-aggregation for the heaviest read paths",
    },
  ];

  return (
    <>
      <details className="card method">
        <summary>
          <span className="method-title">How we measured</span>
          <span className="muted small">
            Speed and size {when(run.run_at)}{load?.run_at ? `, throughput ${when(load.run_at)}` : ""}
          </span>
        </summary>
        <ul>
          <li>Seven queries the app really runs, on the same three months of data in every store</li>
          <li>Each query ran {res[0].runs} times and the median is shown; the 95th percentile stayed within {spread.toFixed(1)}× of it, so the times are steady</li>
          <li>Every store returned the same answers before its times counted</li>
          <li>Under each time: how the store found the data and how much it read, from its query plan (click it for the full plan)</li>
          <li>Sizes are data plus indexes; MongoDB compresses its files and PostgreSQL does not</li>
          <li>Throughput: 1 to 80 simulated users send requests one after another through the real API, logins and restricted database accounts</li>
          <li>The API and the test share one machine, so compare the ratios rather than the absolute numbers</li>
        </ul>
      </details>

      {sections.map((s) => {
        const qs = ofData(s.data);
        const stores = STORES.filter((st) => res.some((r) => r.data === s.data && r.store === st));
        return (
          <div key={s.id} id={s.id} className="card perf-section">
            <div className="card-head">
              <div className="perf-head">
                <span className="card-title section-title">{s.title}</span>
                <span className="answer-tag">{s.answer}</span>
              </div>
              <Proves>{s.proves}</Proves>
            </div>
            <p className="perf-takeaway">{s.takeaway}</p>
            <div className="perf-grid">
              <div>
                <div className="chart-label">Median time <span className="muted">(fastest ticked) and how each store read the data</span></div>
                <div className="table-wrap">
                  <table className="compare">
                    <thead>
                      <tr>
                        <th>Query</th>
                        {stores.map((st) => <th key={st} className="num"><i className={`swatch ${st}`} /> {STORE_LABEL[st]}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {qs.map((q) => {
                        const rows = resultsFor(q);
                        const best = rows.reduce((a, b) => (b.median_ms < a.median_ms ? b : a));
                        return (
                          <tr key={q}>
                            <td>{q}</td>
                            {stores.map((st) => {
                              const r = rows.find((x) => x.store === st);
                              return (
                                <td key={st} className={`num ${r === best ? "best" : ""}`}
                                    title={r ? `95th percentile ${ms(r.p95_ms)}, first run ${ms(r.cold_ms)}` : undefined}>
                                  {r ? ms(r.median_ms) : "–"}{r === best && <span className="best-tick"> ✓</span>}
                                  {r?.plan_summary && (
                                    <button className="plan-how" onClick={() => setPlan(r)}
                                            title="Show the full query plan">{r.plan_summary}</button>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <div className="chart-label">Size <span className="muted">(data and indexes)</span></div>
                <SizeChart rows={sizesOf(s.data)} />
              </div>
            </div>
          </div>
        );
      })}

      <Throughput load={load} />
      {plan && <PlanDialog result={plan} onClose={() => setPlan(null)} />}

    </>
  );
}

// The full query plan behind a summary, as the database printed it.
function PlanDialog({ result, onClose }: { result: BenchmarkResult; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog card plan-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-title">
        <div className="card-head">
          <div className="card-title" id="plan-title">{result.query_name}: {STORE_LABEL[result.store]}</div>
          <button className="link" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted small">{result.plan_summary}</p>
        <pre className="example plan">{result.plan_output}</pre>
      </div>
    </div>
  );
}

// Size: one bar per store, data plus indexes, on a scale shared within the section.
function SizeChart({ rows }: { rows: BenchmarkResult[] }) {
  const max = Math.max(...rows.map((r) => total(r) ?? 0));
  return (
    <div className="size-chart">
      {rows.map((r) => {
        const t = total(r) ?? 0;
        return (
          <div key={`${r.store}-${r.query_name}`} className="size-row"
               title={`Data ${mb(r.storage_bytes)}, indexes ${mb(r.index_bytes)}${r.load_ms != null ? `, loaded in ${seconds(r.load_ms)}` : ""}`}>
            <span className="size-store">
              <i className={`swatch ${r.store}`} />{STORE_LABEL[r.store]}
              {r.store === "mongo_summary" && <span className="muted"> ({r.query_name.split(" ")[0]})</span>}
            </span>
            <span className="size-track"><span className={`bench-fill ${r.store}`} style={{ width: `${(100 * t) / max}%` }} /></span>
            <span className="size-value">{mb(t)}</span>
          </div>
        );
      })}
    </div>
  );
}

// Throughput: for each question, the most requests a second it reached, from
// how many users it stopped growing, and how the response time changed from
// one user to the most users tested.
function Throughput({ load }: { load: LoadTestRun | null }) {
  if (!load) return <div className="card"><p className="muted">Loading the load test…</p></div>;
  if (load.results.length === 0) {
    return (
      <div className="card">
        <div className="card-title section-title">Throughput</div>
        <p className="muted">Run <code>docker compose run --rm loader python etl/load_test.py</code> and reload this page</p>
      </div>
    );
  }
  const byQuestion = new Map<string, LoadTestResult[]>();
  for (const r of load.results) byQuestion.set(r.question, [...(byQuestion.get(r.question) ?? []), r]);
  const rows = [...byQuestion].map(([question, rs]) => {
    const sorted = [...rs].sort((a, b) => a.users - b.users);
    const peak = Math.max(...sorted.map((r) => num(r.requests_per_sec) ?? 0));
    const levelsOff = sorted.find((r) => (num(r.requests_per_sec) ?? 0) >= 0.9 * peak)?.users ?? null;
    return {
      question, peak, levelsOff,
      first: sorted[0], last: sorted[sorted.length - 1],
      failed: sorted.reduce((n, r) => n + r.failed, 0),
      requests: sorted.reduce((n, r) => n + r.requests, 0),
    };
  }).sort((a, b) => b.peak - a.peak);
  const top = rows[0].peak;
  const failed = rows.reduce((n, r) => n + r.failed, 0);
  const requests = rows.reduce((n, r) => n + r.requests, 0);
  const users = rows[0].last.users;
  const typicalLevel = [...rows.map((r) => r.levelsOff ?? 0)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];

  return (
    <div id="throughput" className="card perf-section">
      <div className="card-head">
        <div className="perf-head">
          <span className="card-title section-title">Throughput</span>
          <span className="answer-tag">1 to {users} users at once</span>
        </div>
        <Proves>performance under concurrent load</Proves>
      </div>
      <p className="perf-takeaway">
        {failed === 0 ? `None of ${requests.toLocaleString()} requests failed` : `${failed.toLocaleString()} of ${requests.toLocaleString()} requests failed`},
        and most features stop getting faster at about {typicalLevel} users, after which extra users wait longer instead
      </p>
      <div className="table-wrap">
        <table className="compare throughput">
          <thead>
            <tr>
              <th>Feature</th><th>Database</th><th>Most requests a second</th><th className="num">Stops growing at</th>
              <th className="num">Response time, 1 user</th><th className="num">{users} users</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.question}>
                <td><strong>{r.question}</strong></td>
                <td><span className={`kind-tag ${SERVED_BY[r.question] === "PostgreSQL" ? "pg" : "mongo"}`}>{SERVED_BY[r.question] ?? "API"}</span></td>
                <td>
                  <span className="rps">
                    <span className="rps-track"><span className="rps-fill" style={{ width: `${(100 * r.peak) / top}%` }} /></span>
                    <span className="rps-value">{Math.round(r.peak).toLocaleString()}</span>
                  </span>
                </td>
                <td className="num">{r.levelsOff ?? "–"} users</td>
                <td className="num" title={`95th percentile ${wait(r.first.p95_ms)}`}>{wait(r.first.median_ms)}</td>
                <td className="num" title={`95th percentile ${wait(r.last.p95_ms)}`}>{wait(r.last.median_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
