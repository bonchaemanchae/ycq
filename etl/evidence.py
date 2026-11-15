"""Measurements behind the design choices, on the loaded data.

    python etl/evidence.py                    # all four parts
    python etl/evidence.py --only buckets     # one part: buckets, routing, timestamp or plans

Reads the real databases and changes nothing in them. The benchmark
(etl/benchmark.py) compares the stores; this shows why each store is laid out
as it is.

    buckets     Why activity documents hold sums and counts, not averages.
                The hourly documents are copied twice into time-series
                collections in a scratch database: once with the three
                averages (null for an hour without trips), once as stored.
                For each: buckets used, buckets closed by a change of type,
                load time, and the dashboard summary's time.
    routing     Why the dashboard reads pre-summed collections. Its three
                questions over every loaded month, on the hourly time series
                and on the collection the API picks (dashboard.source), with
                the answers compared.
    timestamp   Why the dashboard filters dates on localDate. The same totals
                with the dates matched on the time series' own timestamp.
    plans       What the databases do for the queries the design relies on:
                PostgreSQL's EXPLAIN ANALYZE for a week of trips (partition
                pruning, the BRIN index) and for the planner's statistics,
                and MongoDB's execution statistics for the dashboard and
                Flow Explorer reads.

Times are medians on this machine and change a little from run to run.
"""
import argparse
import math
import statistics
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from common import ROOT, mongo_db, pg_connect
from load_mongo import BOROUGH_HOURLY, DAILY, HOURLY, OD, avg

sys.path.insert(0, str(ROOT))
from api import dashboard, flows, planner  # noqa: E402

PARTS = ("buckets", "routing", "timestamp", "plans")
RUNS = 5
BATCH = 20_000
NY, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
PLAN_LINES = ("Scan", "Heap Blocks", "Workers Launched", "Execution Time")


def median_ms(fn, runs: int = RUNS) -> float:
    """Median of `runs` timed runs, after one that isn't counted."""
    fn()
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        times.append((time.perf_counter() - t0) * 1000)
    return statistics.median(times)


def loaded_dates(db) -> tuple[str, str]:
    """First and last local date in the hourly collection."""
    first = db[HOURLY].find_one(sort=[("timestamp", 1)])
    last = db[HOURLY].find_one(sort=[("timestamp", -1)])
    if first is None:
        sys.exit("no hourly documents: load a month first (docker compose up -d)")
    return first["localDate"], last["localDate"]


def same(a, b) -> bool:
    """Equal, allowing for sums of floats added up in a different order."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, float) or isinstance(b, float):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=0.005)
    return a == b


# --- buckets ------------------------------------------------------------------

def with_averages(doc: dict) -> dict:
    """The document as it was once stored: an average is null without trips."""
    return {**doc,
            "averageFare": avg(doc["fareSum"], doc["fareTripCount"]),
            "averageDistance": avg(doc["distanceSum"], doc["distanceTripCount"]),
            "averageDurationSec": avg(doc["durationSumSec"], doc["durationTripCount"])}


def buckets(db) -> None:
    source = db[HOURLY]
    scratch = db.client[f"{db.name}_evidence"]
    db.client.drop_database(scratch.name)
    f = dashboard.ActivityFilters(**dict(zip(("dateFrom", "dateTo"), loaded_dates(db))))
    total = source.count_documents({})
    print(f"{total:,} hourly documents copied into two time-series collections "
          f"(scratch database {scratch.name})\n")
    print(f"{'documents hold':<30}{'buckets':>9}{'per bucket':>12}{'closed by type':>16}"
          f"{'load':>8}{'summary':>10}")
    try:
        for label, shape in (("averages, null without trips", with_averages),
                             ("sums and counts (as stored)", dict)):
            scratch.create_collection("hourly", timeseries={
                "timeField": "timestamp", "metaField": "meta", "granularity": "hours"})
            coll = scratch["hourly"]
            batch, t0 = [], time.perf_counter()
            for doc in source.find({}, {"_id": 0}).sort([("timestamp", 1), ("meta.zoneId", 1)]):
                batch.append(shape(doc))
                if len(batch) == BATCH:
                    coll.insert_many(batch, ordered=False)
                    batch = []
            if batch:
                coll.insert_many(batch, ordered=False)
            load = time.perf_counter() - t0
            coll.create_index([("localDate", 1), ("localHour", 1)])
            ts = scratch.command("collStats", "hourly")["timeseries"]
            ms = median_ms(lambda: list(coll.aggregate(dashboard.summary_pipeline(f))))
            print(f"{label:<30}{ts['bucketCount']:>9,}{total / ts['bucketCount']:>12.1f}"
                  f"{ts.get('numBucketsClosedDueToSchemaChange', 0):>16,}{load:>7.1f}s{ms:>8.0f} ms")
            scratch.drop_collection("hourly")
    finally:
        db.client.drop_database(scratch.name)


# --- routing ------------------------------------------------------------------

def questions(db) -> list[tuple[str, str, list[dict]]]:
    """The dashboard's questions over every loaded date: (label, the question
    as dashboard.source names it, pipeline)."""
    dates = dict(zip(("dateFrom", "dateTo"), loaded_dates(db)))
    f = dashboard.ActivityFilters(**dates)
    return [("Summary (map, totals, zones)", "summary", dashboard.summary_pipeline(f)),
            ("Activity over time, by day", "series",
             dashboard.series_pipeline(dashboard.SeriesFilters(**dates, bucket="day"))),
            ("Weekdays and hours", "weekdays", dashboard.weekday_pipeline(f))]


def by_id(rows):
    """Order rows by _id where they have one: $group gives them in any order,
    and in the summary's zone list ties in rank may fall either way."""
    if isinstance(rows, list):
        rows = [by_id(r) for r in rows]
        return sorted(rows, key=lambda r: str(r.get("_id"))) if rows and isinstance(rows[0], dict) else sorted(rows)
    if isinstance(rows, dict):
        return {k: by_id(v) for k, v in rows.items()}
    return rows


def routing(db) -> None:
    f = dashboard.ActivityFilters(**dict(zip(("dateFrom", "dateTo"), loaded_dates(db))))
    print(f"{'question':<30}{'hourly time series':>20}{'collection the API reads':>42}{'answers':>10}")
    for label, question, pipeline in questions(db):
        chosen = dashboard.source(question, f)
        hourly = median_ms(lambda: list(db[HOURLY].aggregate(pipeline)))
        routed = median_ms(lambda: list(db[chosen].aggregate(pipeline)))
        agree = same(by_id(list(db[HOURLY].aggregate(pipeline))), by_id(list(db[chosen].aggregate(pipeline))))
        print(f"{label:<30}{hourly:>17.0f} ms{routed:>10.0f} ms  {chosen:<28}{'same' if agree else 'DIFFERENT':>10}")


# --- timestamp ----------------------------------------------------------------

def timestamp(db) -> None:
    first, last = loaded_dates(db)
    start = datetime.fromisoformat(first).replace(tzinfo=NY).astimezone(UTC)
    end = (datetime.fromisoformat(last) + timedelta(days=1)).replace(tzinfo=NY).astimezone(UTC)
    totals = {"$group": {"_id": "$meta.zoneId", "pickups": {"$sum": "$pickups"},
                         "dropoffs": {"$sum": "$dropoffs"}}}
    by_date = [{"$match": {"localDate": {"$gte": first, "$lte": last}}}, totals]
    by_time = [{"$match": {"timestamp": {"$gte": start, "$lt": end}}}, totals]
    a, b = (sorted(db[HOURLY].aggregate(p), key=lambda r: r["_id"]) for p in (by_date, by_time))
    print(f"every zone's totals, {first} to {last}, on {HOURLY}")
    for label, pipeline in (("dates matched on localDate", by_date), ("dates matched on timestamp", by_time)):
        print(f"  {label:<30}{median_ms(lambda: list(db[HOURLY].aggregate(pipeline))):>8.0f} ms")
    print(f"  answers {'the same' if a == b else 'DIFFERENT'}")


# --- plans --------------------------------------------------------------------

def pg_plan(conn, title: str, sql: str, params) -> None:
    print(f"\n{title}")
    conn.execute(sql, params).fetchall()      # once uncounted, so the plan is timed with its pages in memory
    for (line,) in conn.execute(f"EXPLAIN (ANALYZE, BUFFERS) {sql}", params):
        if any(word in line for word in PLAN_LINES):
            print("   ", line.strip())


def mongo_stats(db, title: str, name: str, pipeline: list[dict]) -> None:
    """Stage names, documents (or buckets) examined and time, from
    explain("executionStats"). Each is the largest reported anywhere in the plan."""
    plan = db.command("explain", {"aggregate": name, "pipeline": pipeline, "cursor": {}},
                      verbosity="executionStats")
    stages, examined, ms = set(), 0, 0

    def walk(node):
        nonlocal examined, ms
        if isinstance(node, dict):
            if isinstance(node.get("stage"), str) and node["stage"].isupper():
                stages.add(node["stage"])
            examined = max(examined, node.get("totalDocsExamined", 0))
            ms = max(ms, node.get("executionTimeMillis", 0))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(plan)
    print(f"\n{title} ({name})")
    print(f"    stages {', '.join(sorted(stages))}; examined {examined:,}; {ms} ms")


def plans(conn, db) -> None:
    month = conn.execute("SELECT max(file_month) FROM import_batch WHERE status = 'completed'").fetchone()[0]
    if month is None:
        sys.exit("no month imported")
    pg_plan(conn, f"PostgreSQL: trips picked up in the first week of {month:%B %Y}",
            "SELECT count(*), sum(total_amount) FROM trip WHERE pickup_ts >= %s AND pickup_ts < %s",
            (month, month + timedelta(days=7)))

    manhattan = conn.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'").fetchone()
    pg_plan(conn, "PostgreSQL: the planner's statistics, Mondays 7 to 9 AM in Manhattan",
            planner.STATS_SQL,
            {"iso_dow": 1, "start_hour": 7, "end_hour": 9, "borough_ids": [manhattan[0]] if manhattan else []})

    for label, question, pipeline in questions(db):
        if question == "summary":
            mongo_stats(db, "MongoDB: dashboard summary on the hourly time series", HOURLY, pipeline)
            mongo_stats(db, "MongoDB: the same summary on the daily documents", DAILY, pipeline)
        elif question == "weekdays":
            mongo_stats(db, "MongoDB: weekdays and hours on the borough documents", BOROUGH_HOURLY, pipeline)
    snapshot = db[OD].find_one(sort=[("totalTrips", -1)])
    if snapshot:
        mongo_stats(db, f"MongoDB: Flow Explorer, origin zone {snapshot['originZoneId']}", OD,
                    flows.slice_pipeline(flows.SliceQuery(**{
                        k: snapshot[k] for k in ("originZoneId", "month", "dayType", "timeBucket")})))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=PARTS, help="run one part")
    args = ap.parse_args()
    db = mongo_db()
    with pg_connect(autocommit=True) as conn:
        run = {"buckets": lambda: buckets(db), "routing": lambda: routing(db),
               "timestamp": lambda: timestamp(db), "plans": lambda: plans(conn, db)}
        for part in PARTS:
            if args.only in (None, part):
                print(f"\n=== {part} " + "=" * (60 - len(part)))
                run[part]()
    print("\nnothing was changed")


if __name__ == "__main__":
    main()
