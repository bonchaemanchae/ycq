import { STORE_LABEL, mb, ms, when, type BenchmarkResult, type BenchmarkRun } from "./types";

type Store = BenchmarkResult["store"];

const STORES: Store[] = ["postgres", "mongo_collection", "mongo_timeseries", "mongo_summary"];

const DATA_LABEL: Record<BenchmarkResult["data"], string> = {
  hourly: "Hourly zone summaries (Q1–Q4)",
  destinations: "Destination lists (Q5)",
  dashboard: "Activity Dashboard (Q6–Q7)",
};

const QUESTION_NOTE: Record<BenchmarkResult["data"], string> = {
  hourly: "",
  destinations:
    "PostgreSQL sorts every destination of the zone and keeps 10; MongoDB reads one document " +
    "that already holds the top 10.",
  dashboard:
    "The app's own stores. MongoDB pre-summed is what the dashboard reads: one document per zone and " +
    "day (Q6) or per borough and hour (Q7), instead of one per zone and hour.",
};

const seconds = (v: number | null) => (v == null ? "–" : `${(v / 1000).toFixed(1)} s`);

// One row per store that holds the data, in STORES order: every question on
// the same store has the same sizes, except the two pre-summed collections.
const sizeRows = (results: BenchmarkResult[]) =>
  STORES.flatMap((s) => {
    const rows = results.filter((r) => r.store === s);
    return s === "mongo_summary" ? rows : rows.slice(0, 1);
  });

// Which database answers the app's questions faster. One small bar chart per
// question (each on its own scale, because the questions differ a lot in
// size), a table of every timing, then space, load time and query plans.
export default function Benchmarks({ run }: { run: BenchmarkRun }) {
  if (run.results.length === 0) {
    return (
      <div className="card">
        <div className="card-title">Which database answers faster?</div>
        <p className="muted">
          The benchmark hasn't been run yet. Run{" "}
          <code>docker compose run --rm loader python etl/benchmark.py</code> and reload this page.
        </p>
      </div>
    );
  }

  const queries = [...new Set(run.results.map((r) => r.query_name))];
  const resultsFor = (query: string) =>
    STORES.map((s) => run.results.find((r) => r.store === s && r.query_name === query))
      .filter((r): r is BenchmarkResult => r !== undefined);
  const runs = run.results[0].runs;

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Which database answers faster?</div>
        <div className="legend" aria-hidden="true">
          {STORES.filter((s) => run.results.some((r) => r.store === s))
            .map((s) => <span key={s}><i className={`swatch ${s}`} />{STORE_LABEL[s]}</span>)}
        </div>
      </div>
      <p className="muted small">
        Questions 1 to 4 ask the same hourly zone summaries, stored three ways. Question 5 asks for the
        Flow Explorer's top 10 destinations, the case MongoDB was chosen for. Questions 6 and 7 are the
        Activity Dashboard's heaviest, over all three months. Each question ran {runs} times;
        bars show the typical (median) time, so shorter is faster. Every store gave the same answers.
        Measured {when(run.run_at)}.
      </p>

      <div className="bench-grid">
        {queries.map((q) => {
          const rows = resultsFor(q);
          const max = Math.max(...rows.map((r) => r.median_ms));
          const fastest = rows.reduce((a, b) => (b.median_ms < a.median_ms ? b : a));
          const note = QUESTION_NOTE[rows[0].data];
          return (
            <div key={q} className="bench-query">
              <div className="bench-title">{q}</div>
              {note && <p className="muted small">{note}</p>}
              {rows.map((r) => (
                <div key={r.store} className="bench-row"
                     title={`${STORE_LABEL[r.store]}: median ${ms(r.median_ms)}, ` +
                            `95th percentile ${ms(r.p95_ms)}, first run ${ms(r.cold_ms)}`}>
                  <span className="bench-store">{STORE_LABEL[r.store]}</span>
                  <span className="bench-track">
                    <span className={`bench-fill ${r.store}`} style={{ width: `${(100 * r.median_ms) / max}%` }} />
                  </span>
                  <span className="bench-value">
                    {ms(r.median_ms)}{r === fastest && <span className="tag good">fastest</span>}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="table-wrap bench-table">
        <table>
          <thead>
            <tr>
              <th>Question</th><th>Store</th>
              <th className="num">Median</th><th className="num">95th percentile</th><th className="num">First run</th>
            </tr>
          </thead>
          <tbody>
            {queries.flatMap((q) => resultsFor(q).map((r) => (
              <tr key={`${q}-${r.store}`}>
                <td>{q}</td><td>{STORE_LABEL[r.store]}</td>
                <td className="num">{ms(r.median_ms)}</td>
                <td className="num">{ms(r.p95_ms)}</td>
                <td className="num">{ms(r.cold_ms)}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>

      <div className="card-title bench-subtitle">Space and load time</div>
      <p className="muted small">
        MongoDB compresses data on disk by default and PostgreSQL does not, so sizes reflect compression as well
        as layout. The destination lists are the app's own stores: PostgreSQL keeps every destination, MongoDB
        only each slice's top 10, which is the point of that design.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Data</th><th>Store</th><th className="num">Data size</th><th className="num">Indexes</th>
              <th className="num">Total</th><th className="num">Time to load</th>
            </tr>
          </thead>
          <tbody>
            {(["hourly", "destinations", "dashboard"] as const).flatMap((data) =>
              sizeRows(run.results.filter((r) => r.data === data))
                .map((r) => {
                  const total = r.storage_bytes != null && r.index_bytes != null
                    ? r.storage_bytes + r.index_bytes : null;
                  // Q6 and Q7 read different pre-summed collections, so say which.
                  const which = r.store === "mongo_summary" ? ` (${r.query_name.split(" ")[0]})` : "";
                  return (
                    <tr key={`${data}-${r.store}-${r.query_name}`}>
                      <td>{DATA_LABEL[data]}</td>
                      <td><i className={`swatch ${r.store}`} /> {STORE_LABEL[r.store]}{which}</td>
                      <td className="num">{mb(r.storage_bytes)}</td>
                      <td className="num">{mb(r.index_bytes)}</td>
                      <td className="num">{mb(total)}</td>
                      <td className="num">{seconds(r.load_ms)}</td>
                    </tr>
                  );
                }))}
          </tbody>
        </table>
      </div>

      <details className="more">
        <summary>How each database ran each question (query plans)</summary>
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
  );
}
