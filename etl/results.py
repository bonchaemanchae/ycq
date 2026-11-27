"""Show the performance results: ours, which come with the code, and your own
latest run if you have made one.

    python etl/results.py              # our results, then your latest run if there is one
    python etl/results.py --full       # also every number of users in the load test
    python etl/results.py --export     # save this database's latest runs as ours (etl/results/)

The speed benchmark (etl/benchmark.py) and the load test (etl/load_test.py)
save every run in PostgreSQL (benchmark_run, load_test_run). The runs behind
the presentation are copied into etl/results/benchmark.json and
load_test.json, because a fresh install loads the trip data but none of our
runs. Run the two scripts to measure your own machine, then run this again
to see your numbers beside ours. Times differ between computers, so compare
the ratios: which store wins each query, how much smaller each store is, and
which feature handles the most requests.
"""
import argparse
import json
import re
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from psycopg.rows import dict_row

from common import pg_connect

SAVED = Path(__file__).parent / "results"
STORES = ["postgres", "mongo_collection", "mongo_timeseries", "mongo_summary"]
STORE_LABEL = {"postgres": "PostgreSQL", "mongo_collection": "MongoDB collection",
               "mongo_timeseries": "MongoDB time-series", "mongo_summary": "MongoDB pre-summed"}
# The kind of data each benchmark query reads (etl/benchmark.py)
DATA = {"hourly": "Hourly zone summaries (Q1 to Q4)", "destinations": "Top 10 destinations per zone (Q5)",
        "dashboard": "Dashboard totals (Q6, Q7)"}
# Which database answers each load-tested feature (etl/load_test.py)
SERVED_BY = {"Flow Explorer": "MongoDB", "Map, daily summary": "MongoDB", "Map, hourly data": "MongoDB",
             "Weekday chart": "MongoDB", "Planner preview": "PostgreSQL"}


def data_of(query: str) -> str:
    return {"Q5": "destinations", "Q6": "dashboard", "Q7": "dashboard"}.get(query[:2], "hourly")


def plan_summary(store: str, plan: str | None) -> str | None:
    """How a database ran a benchmark query, in a few words, from its saved
    query plan: the way it found the data and how much it read. PostgreSQL
    plans are EXPLAIN (ANALYZE, BUFFERS) text, read in 8 kB pages; MongoDB
    plans are explain("executionStats") JSON, read in documents, or in
    compressed buckets for a time-series collection."""
    if not plan:
        return None
    if store == "postgres":
        how = ("full table scan" if "Seq Scan" in plan else "bitmap index scan" if "Bitmap" in plan
               else "index-only scan" if "Index Only Scan" in plan else "index scan" if "Index Scan" in plan else "scan")
        if "Parallel" in plan:
            how = f"parallel {how}"
        first = re.search(r"Buffers: shared(?: hit=(\d+))?(?: read=(\d+))?", plan)
        pages = sum(int(x) for x in first.groups() if x) if first else None
        return f"{how}, {pages:,} {'page' if pages == 1 else 'pages'}" if pages is not None else how
    try:
        text = json.dumps(json.loads(plan))
    except ValueError:
        return None
    examined = [int(x) for x in re.findall(r'"totalDocsExamined": (\d+)', text)]
    read = max(examined) if examined else None
    if "UNPACK_TS_BUCKET" in text or store == "mongo_timeseries":
        return f"{read:,} {'bucket' if read == 1 else 'buckets'}" if read is not None else "buckets"
    how = "full scan" if "COLLSCAN" in text else "index scan"
    return f"{how}, {read:,} {'document' if read == 1 else 'documents'}" if read is not None else how


def _plain(row: dict) -> dict:
    """A database row as JSON-ready values."""
    return {k: (float(v) if isinstance(v, Decimal) else v.isoformat() if isinstance(v, datetime) else v)
            for k, v in row.items()}


def latest_benchmark(conn) -> dict:
    """Every result of the most recent benchmark run (one row per store and
    query), with when it ran and how each store read the data. Empty if the
    benchmark hasn't been run."""
    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(
            """SELECT store, query_name, runs, cold_ms, median_ms, p95_ms,
                      storage_bytes, index_bytes, load_ms, plan_output, run_at
               FROM benchmark_run
               WHERE run_at = (SELECT max(run_at) FROM benchmark_run)
               ORDER BY query_name, store""").fetchall()
    run_at = rows[0]["run_at"].isoformat() if rows else None
    results = []
    for r in rows:
        summary = plan_summary(r["store"], r.pop("plan_output"))
        r.pop("run_at")
        results.append({**_plain(r), "plan_summary": summary})
    return {"run_at": run_at, "results": results}


def latest_load_test(conn) -> dict:
    """Every result of the most recent load test: one row per question and
    number of simultaneous users. Empty if it hasn't been run."""
    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(
            """SELECT question, users, seconds, requests, failed, requests_per_sec,
                      median_ms, p95_ms, run_at
               FROM load_test_run
               WHERE run_at = (SELECT max(run_at) FROM load_test_run)
               ORDER BY question, users""").fetchall()
    run_at = rows[0]["run_at"].isoformat() if rows else None
    return {"run_at": run_at, "results": [_plain({k: v for k, v in r.items() if k != "run_at"}) for r in rows]}


# --- printing ---------------------------------------------------------------

def rounded(v: float, places: int) -> str:
    """v to a number of decimal places, halves rounded up, as the slides were
    (Python's own rounding would print 89.25 as 89.2)."""
    return str(Decimal(str(v)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def ms(v: float) -> str:
    return f"{rounded(v, 2)} ms" if v < 10 else f"{rounded(v, 1)} ms" if v < 1000 else f"{rounded(v / 1000, 1)} s"


def mb(b: float | None) -> str:
    return "–" if b is None else f"{rounded(b / 1_048_576, 1)} MB"


def day(iso: str | None) -> str:
    return datetime.fromisoformat(iso).strftime("%d %b %Y").lstrip("0") if iso else "–"


def benchmark_lines(run: dict) -> list[str]:
    res = run["results"]
    runs = res[0]["runs"]
    out = [f"Speed and size, run {day(run['run_at'])}: median of {runs} runs, fastest marked",
           "Every store returned the same answers before its times counted", ""]
    for q in dict.fromkeys(r["query_name"] for r in res):
        rows = sorted((r for r in res if r["query_name"] == q), key=lambda r: STORES.index(r["store"]))
        best = min(rows, key=lambda r: r["median_ms"])
        out.append(q)
        for r in rows:
            mark = "fastest" if r is best else ""
            out.append(f"  {STORE_LABEL[r['store']]:<21}{ms(r['median_ms']):>10}  {mark:<8} {r['plan_summary'] or ''}")
    out += ["", "Size (data plus indexes) and load time"]
    for data, title in DATA.items():
        out.append(f"  {title}")
        for store in STORES:
            rows = [r for r in res if data_of(r["query_name"]) == data and r["store"] == store]
            for r in (rows if store == "mongo_summary" else rows[:1]):
                size = (r["storage_bytes"] or 0) + (r["index_bytes"] or 0) if r["storage_bytes"] is not None else None
                label = STORE_LABEL[store] + (f" ({r['query_name'][:2]})" if store == "mongo_summary" else "")
                load = f"   loaded in {rounded(r['load_ms'] / 1000, 1)} s" if r.get("load_ms") else ""
                out.append(f"    {label:<26}{mb(size):>10}{load}")
    return out


def load_test_lines(run: dict, full: bool = False) -> list[str]:
    res = run["results"]
    requests, failed = sum(r["requests"] for r in res), sum(r["failed"] for r in res)
    users = sorted({r["users"] for r in res})
    out = [f"Throughput, run {day(run['run_at'])}: {users[0]} to {users[-1]} users at once, "
           f"{requests:,} requests, {failed:,} failed", ""]
    rows = []
    for q in dict.fromkeys(r["question"] for r in res):
        rs = sorted((r for r in res if r["question"] == q), key=lambda r: r["users"])
        peak = max(r["requests_per_sec"] for r in rs)
        levels = next(r["users"] for r in rs if r["requests_per_sec"] >= 0.9 * peak)
        rows.append((peak, q, levels, rs))
    out.append(f"  {'Feature':<20}{'Database':<12}{'Most req/s':>11}{'Stops growing at':>18}"
               f"{'1 user':>11}{f'{users[-1]} users':>11}")
    for peak, q, levels, rs in sorted(rows, reverse=True):
        out.append(f"  {q:<20}{SERVED_BY.get(q, 'API'):<12}{rounded(peak, 0):>11}{f'{levels} users':>18}"
                   f"{ms(rs[0]['median_ms']):>11}{ms(rs[-1]['median_ms']):>11}")
    out += ["", "  Stops growing at: the first number of users reaching 90% of the feature's peak",
            "  Response times are medians; the API and the test share one machine, so compare ratios"]
    if full:
        out += ["", f"  {'Feature':<20}{'Users':>6}{'Req/s':>9}{'Median':>11}{'95th pct':>11}{'Failed':>8}"]
        for _, q, _, rs in rows:
            for r in rs:
                out.append(f"  {q:<20}{r['users']:>6}{rounded(r['requests_per_sec'], 1):>9}{ms(r['median_ms']):>11}"
                           f"{ms(r['p95_ms']):>11}{r['failed']:>8}")
    return out


def saved(name: str) -> dict | None:
    path = SAVED / f"{name}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--full", action="store_true", help="also every number of users in the load test")
    ap.add_argument("--export", action="store_true",
                    help="save this database's latest runs to etl/results/ as ours (for the team)")
    args = ap.parse_args()

    if args.export:
        with pg_connect() as conn:
            for name, run in (("benchmark", latest_benchmark(conn)), ("load_test", latest_load_test(conn))):
                if not run["results"]:
                    raise SystemExit(f"no {name} run in this database to export")
                SAVED.mkdir(exist_ok=True)
                (SAVED / f"{name}.json").write_text(json.dumps(run, indent=1) + "\n", encoding="utf-8")
                print(f"saved {len(run['results'])} results to etl/results/{name}.json")
        return

    ours = {"benchmark": saved("benchmark"), "load_test": saved("load_test")}
    print("=== Our results (the runs behind the presentation) " + "=" * 28)
    for name, lines in (("benchmark", benchmark_lines), ("load_test", load_test_lines)):
        if ours[name]:
            print("\n" + "\n".join(lines(ours[name], args.full) if name == "load_test" else lines(ours[name])))

    try:
        with pg_connect() as conn:
            yours = {"benchmark": latest_benchmark(conn), "load_test": latest_load_test(conn)}
    except Exception as e:   # the databases aren't running
        print(f"\n(Couldn't read your own runs: {e.__class__.__name__}. Start the app with docker compose up -d.)")
        return
    new = {k: v for k, v in yours.items() if v["results"] and (not ours[k] or v["run_at"] != ours[k]["run_at"])}
    if new:
        print("\n=== Your latest run " + "=" * 60)
        if "benchmark" in new:
            print("\n" + "\n".join(benchmark_lines(new["benchmark"])))
        if "load_test" in new:
            print("\n" + "\n".join(load_test_lines(new["load_test"], args.full)))
    missing = [k for k in ("benchmark", "load_test") if k not in new]
    if missing:
        print("\nTo measure your own machine, run these, then this script again:")
        if "benchmark" in missing:
            print("  docker compose run --rm loader python etl/benchmark.py     # a few minutes")
        if "load_test" in missing:
            print("  docker compose run --rm loader python etl/load_test.py     # about 10 minutes")


if __name__ == "__main__":
    main()
