import Proves from "./Proves";
import { STORE_LABEL, mb, ms, when, type BenchmarkResult, type BenchmarkRun } from "./types";

type Store = BenchmarkResult["store"];
type Data = BenchmarkResult["data"];

const STORES: Store[] = ["postgres", "mongo_collection", "mongo_timeseries", "mongo_summary"];

const total = (r: BenchmarkResult | undefined) =>
  r && r.storage_bytes != null && r.index_bytes != null ? r.storage_bytes + r.index_bytes : null;
const times = (a: number, b: number) => `${(a / b).toFixed(a / b < 10 ? 1 : 0)}×`;
const seconds = (v: number | null) => (v == null ? "–" : `${(v / 1000).toFixed(1)} s`);
const tick = (v: number) => (v < 1 ? `${v}` : v.toLocaleString());

// A log axis shared by every speed chart on the page, so a dot means the same
// time everywhere: from the decade below the fastest result to a round number
// just above the slowest.
function logAxis(values: number[]) {
  const lo = 10 ** Math.floor(Math.log10(Math.min(...values)));
  const top = Math.max(...values) * 1.1;
  const k = 10 ** Math.floor(Math.log10(top));
  const hi = [1, 2, 5, 10].map((m) => m * k).find((v) => v >= top) ?? 10 * k;
  const at = (v: number) => (100 * (Math.log10(v) - Math.log10(lo))) / (Math.log10(hi) - Math.log10(lo));
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t *= 10) ticks.push(Number(t.toPrecision(1)));
  return { at, ticks };
}

// Speed: one row per question, one dot per store on the shared log axis.
// Further left is faster; the fastest time is written at the end of the row.
function SpeedChart({ rows, axis }: {
  rows: { q: string; results: BenchmarkResult[] }[]; axis: ReturnType<typeof logAxis>;
}) {
  return (
    <div className="speed-chart">
      {rows.map(({ q, results }) => {
        const best = results.reduce((a, b) => (b.median_ms < a.median_ms ? b : a));
        return (
          <div key={q} className="speed-row">
            <span className="speed-q" title={q}>{q}</span>
            <span className="speed-track">
              {axis.ticks.map((t) => <i key={t} className="speed-grid" style={{ left: `${axis.at(t)}%` }} />)}
              {results.map((r) => (
                <span key={r.store} className={`speed-dot ${r.store}`} style={{ left: `${axis.at(r.median_ms)}%` }}
                      title={`${STORE_LABEL[r.store]}: median ${ms(r.median_ms)}, 95th percentile ${ms(r.p95_ms)}`} />
              ))}
            </span>
            <span className="speed-best" title={`Fastest: ${STORE_LABEL[best.store]}`}>
              <i className={`swatch ${best.store}`} />{ms(best.median_ms)}
            </span>
          </div>
        );
      })}
      <div className="speed-row speed-axis" aria-hidden="true">
        <span />
        <span className="speed-track">
          {axis.ticks.map((t) => <span key={t} className="speed-tick" style={{ left: `${axis.at(t)}%` }}>{tick(t)}</span>)}
        </span>
        <span className="muted small">ms, log scale</span>
      </div>
    </div>
  );
}

// Size: one bar per store, data plus indexes, on a scale shared within the card.
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

// The benchmark, organised around the three design decisions it settled. Each
// card's title is the decision; under it, speed on the left and size on the
// right. Exact timings, sizes and query plans are folded away at the bottom.
export default function Benchmarks({ run }: { run: BenchmarkRun }) {
  if (run.results.length === 0) {
    return (
      <div className="card">
        <div className="card-title">No benchmark yet</div>
        <p className="muted">
          Run <code>docker compose run --rm loader python etl/benchmark.py</code> and reload this page.
        </p>
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
  const axis = logAxis(res.map((r) => r.median_ms));

  // the headline numbers behind each decision
  const pgHourly = total(one("hourly", "postgres")), tsHourly = total(one("hourly", "mongo_timeseries"));
  const pgDest = total(one("destinations", "postgres")), mgDest = total(one("destinations", "mongo_collection"));
  const speedups = ofData("dashboard").map((q) => {
    const pg = one("dashboard", "postgres", q), sum = one("dashboard", "mongo_summary", q);
    return pg && sum ? pg.median_ms / sum.median_ms : null;
  }).filter((x): x is number => x != null);
  const smallerHourly = pgHourly && tsHourly ? `${times(pgHourly, tsHourly)} smaller` : "Smaller";
  const smallerDest = pgDest && mgDest ? `${times(pgDest, mgDest)} smaller` : "Smaller";
  const faster = speedups.length ? `${times(Math.min(...speedups), 1)} to ${times(Math.max(...speedups), 1)} faster` : "Faster";

  const sections: { id: string; data: Data; title: string; verdict: string; proves: string }[] = [
    {
      id: "hourly", data: "hourly",
      title: "Decision 1: hourly zone summaries go in a MongoDB time-series collection",
      verdict: `${smallerHourly} than PostgreSQL. PostgreSQL wins tiny lookups, but on month-wide questions the time-series collection keeps up or wins.`,
      proves: "a storage choice backed by measurement",
    },
    {
      id: "destinations", data: "destinations",
      title: "Decision 2: the Flow Explorer reads its top 10 destinations from MongoDB",
      verdict: `${smallerDest}, because each document stores only the top 10, already sorted. Both stores answer in under a millisecond.`,
      proves: "a document model shaped by the question it answers",
    },
    {
      id: "dashboard", data: "dashboard",
      title: "Decision 3: the Analytical Dashboard reads pre-summed MongoDB collections",
      verdict: `${faster} than PostgreSQL on the dashboard's two heaviest questions, for a few megabytes of extra storage.`,
      proves: "pre-aggregation for the heaviest read paths",
    },
  ];

  const findings = [
    { href: "#hourly", value: smallerHourly, label: "hourly summaries in a time-series collection, close to PostgreSQL's speed" },
    { href: "#destinations", value: smallerDest, label: "Flow Explorer's top 10 lists in MongoDB, still under a millisecond" },
    { href: "#dashboard", value: faster, label: "dashboard reads from pre-summed collections instead of PostgreSQL" },
  ];

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="card-title">What we found</div>
          <Proves>performance evaluation of both databases</Proves>
        </div>
        <div className="finding-tiles">
          {findings.map((f) => (
            <a key={f.href} href={f.href} className="finding-tile">
              <span className="finding-value">{f.value}</span>
              <span className="finding-label">{f.label}</span>
            </a>
          ))}
        </div>
        <p className="muted small bench-conditions">
          Seven of the app's real questions, each run {res[0].runs} times on the same data in every store, with the
          answers checked to match. Charts show the median time. Measured {when(run.run_at)}.
        </p>
      </div>

      {sections.map((s) => {
        const qs = ofData(s.data);
        const stores = STORES.filter((st) => res.some((r) => r.data === s.data && r.store === st));
        return (
          <div key={s.id} id={s.id} className="card bench-section">
            <div className="card-head">
              <div className="card-title">{s.title}</div>
              <Proves>{s.proves}</Proves>
            </div>
            <p className="bench-verdict">{s.verdict}</p>
            <div className="legend bench-legend" aria-label="Stores">
              {stores.map((st) => <span key={st}><i className={`swatch ${st}`} />{STORE_LABEL[st]}</span>)}
            </div>
            <div className="bench-charts">
              <div>
                <div className="chart-label">Speed <span className="muted">(median; further left is faster)</span></div>
                <SpeedChart rows={qs.map((q) => ({ q, results: resultsFor(q) }))} axis={axis} />
              </div>
              <div>
                <div className="chart-label">Size <span className="muted">(data and indexes)</span></div>
                <SizeChart rows={sizesOf(s.data)} />
              </div>
            </div>
          </div>
        );
      })}

      <div className="card">
        <details className="more">
          <summary>Exact timings: median, 95th percentile and first run</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Question</th><th>Store</th><th className="num">Median</th><th className="num">95th percentile</th><th className="num">First run</th></tr>
              </thead>
              <tbody>
                {queries.flatMap((q) => resultsFor(q).map((r) => (
                  <tr key={`${q}-${r.store}`}>
                    <td>{q}</td><td>{STORE_LABEL[r.store]}</td>
                    <td className="num">{ms(r.median_ms)}</td><td className="num">{ms(r.p95_ms)}</td><td className="num">{ms(r.cold_ms)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </details>
        <details className="more">
          <summary>Sizes and load times</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Decision</th><th>Store</th><th className="num">Data</th><th className="num">Indexes</th><th className="num">Total</th><th className="num">Load time</th></tr>
              </thead>
              <tbody>
                {sections.flatMap((s, i) => sizesOf(s.data).map((r) => (
                  <tr key={`${s.id}-${r.store}-${r.query_name}`}>
                    <td>{i + 1}</td>
                    <td>
                      {STORE_LABEL[r.store]}
                      {r.store === "mongo_summary" && <span className="muted"> ({r.query_name.split(" ")[0]})</span>}
                    </td>
                    <td className="num">{mb(r.storage_bytes)}</td><td className="num">{mb(r.index_bytes)}</td>
                    <td className="num">{mb(total(r))}</td><td className="num">{seconds(r.load_ms)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            MongoDB compresses data on disk by default and PostgreSQL does not, so sizes reflect compression as well as layout.
          </p>
        </details>
        <details className="more">
          <summary>Query plans: how each database ran each question</summary>
          {queries.map((q) => (
            <div key={q} className="bench-plans">
              <div className="bench-title">{q}</div>
              {resultsFor(q).map((r) => (
                <details key={r.store}>
                  <summary className="small">{STORE_LABEL[r.store]}</summary>
                  <pre className="example plan">{r.plan_output ?? "–"}</pre>
                </details>
              ))}
            </div>
          ))}
        </details>
      </div>
    </>
  );
}
