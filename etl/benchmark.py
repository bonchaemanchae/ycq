"""Benchmark PostgreSQL against MongoDB on the app's own questions.

    python etl/benchmark.py                    # 50 timed runs per query
    python etl/benchmark.py --runs 10          # quicker
    python etl/benchmark.py --zone 237         # a different zone for Q1, Q2 and Q5
    python etl/benchmark.py --explain-summary 2026-01

Q1 to Q4 use the hourly zone summaries (zone_hour_observation), copied into
three benchmark stores that are built the same way and have equivalent indexes:

    postgres           table bench_zone_hour
    mongo_collection   normal collection bench_zone_hour_collection
    mongo_timeseries   time-series collection bench_zone_hour_timeseries

    Q1  one zone, one hour
    Q2  one zone over seven days
    Q3  totals for every zone over a month
    Q4  top 10 zones by pickups over a month

Q5 tests the case MongoDB was chosen for, the Flow Explorer: the top 10
destinations for one origin zone, month, day type and time bucket. PostgreSQL
filters, sorts and limits od_summary; MongoDB reads one document from
origin_destination_snapshots with the top 10 already embedded. Both are the
app's real stores, already indexed for this lookup. The time-series
collection isn't part of Q5, because destination lists aren't time series.

For each query and store it records the first (cold) run, then the median and
95th percentile of --runs further runs, the store's data and index size, the
time to load the store (Q1 to Q4 only), and the query plan (EXPLAIN ANALYZE in
PostgreSQL, explain("executionStats") in MongoDB). The stores' answers are
compared first; if any store gives a different answer the benchmark stops
without saving, because a fast wrong answer means nothing. Results go to
benchmark_run (one row per store and query) and appear on the Administration
page.

Times are measured in this script, so they include the driver, the same for
every store. Load times start once the connections are open. "Cold" means the
first run after the store was built; the operating system may still have the
data in memory.

--explain-summary MONTH prints EXPLAIN ANALYZE of that month's hourly summary
build (build_aggregates.py), inside a transaction that is rolled back.
"""
import argparse
import json
import math
import statistics
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row
from pymongo import ASCENDING

from build_aggregates import GRID_SQL
from common import mongo_db, next_month, parse_month, pg_connect
from load_mongo import OD, hourly_fields

PG_TABLE = "bench_zone_hour"
MONGO_COLLECTION = "bench_zone_hour_collection"
MONGO_TIMESERIES = "bench_zone_hour_timeseries"
HOURLY_STORES = ("postgres", "mongo_collection", "mongo_timeseries")
NY = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")
BATCH = 20_000

# The same parameters for every store. Times are New York local; MongoDB's
# hourly documents are queried by the equivalent UTC instants, so both select
# the same hours, also across the daylight-saving change.
DEFAULT_ZONE = 161                           # Midtown Center, one of the busiest zones
HOUR = datetime(2026, 1, 9, 18)              # a Friday, 6 PM
WEEK = (datetime(2026, 1, 5), datetime(2026, 1, 12))
MONTH = (datetime(2026, 3, 1), datetime(2026, 4, 1))   # includes the 8 March clock change
FLOW_QUERY = "Q5 top 10 destinations, one origin"


def utc(local: datetime) -> datetime:
    return local.replace(tzinfo=NY).astimezone(UTC)


# --- building the hourly stores ---------------------------------------------

SOURCE_SQL = """
    SELECT h.location_id, b.name AS borough, h.obs_hour, h.obs_hour_utc, h.local_date,
           h.local_hour, h.iso_dow, h.pickups, h.dropoffs, h.fare_sum, h.fare_trip_count,
           h.distance_sum, h.distance_trip_count, h.duration_sum_s, h.duration_trip_count
    FROM zone_hour_observation h
    JOIN taxi_zone z USING (location_id)
    JOIN borough b USING (borough_id)
    ORDER BY h.obs_hour, h.location_id
"""

PG_COLUMNS = ["location_id", "obs_hour", "obs_hour_utc", "local_date", "local_hour", "iso_dow",
              "pickups", "dropoffs", "fare_sum", "fare_trip_count", "distance_sum",
              "distance_trip_count", "duration_sum_s", "duration_trip_count"]


def source_rows(conn):
    """Every hourly summary row, streamed with a server-side cursor."""
    with conn.cursor(name="bench_source", row_factory=dict_row) as cur:
        cur.itersize = BATCH
        cur.execute(SOURCE_SQL)
        yield from cur


def build_postgres(conn) -> tuple[float, int]:
    """Copy the rows into bench_zone_hour, then add the same keys and indexes
    as zone_hour_observation. Returns (load ms, rows)."""
    conn.execute(f"DROP TABLE IF EXISTS {PG_TABLE}")
    conn.execute(f"CREATE TABLE {PG_TABLE} (LIKE zone_hour_observation INCLUDING DEFAULTS)")
    rows = 0
    with pg_connect() as reader, conn.cursor() as cur:
        t0 = time.perf_counter()
        with cur.copy(f"COPY {PG_TABLE} ({', '.join(PG_COLUMNS)}) FROM STDIN") as copy:
            for r in source_rows(reader):
                copy.write_row([r[c] for c in PG_COLUMNS])
                rows += 1
        cur.execute(f"ALTER TABLE {PG_TABLE} ADD PRIMARY KEY (location_id, obs_hour)")
        cur.execute(f"CREATE INDEX ON {PG_TABLE} (obs_hour)")
        cur.execute(f"CREATE INDEX ON {PG_TABLE} (iso_dow, local_hour)")
        load_ms = (time.perf_counter() - t0) * 1000
    conn.execute(f"VACUUM ANALYZE {PG_TABLE}")
    return load_ms, rows


def to_document(r: dict) -> dict:
    """The same document shape as zone_activity_timeseries (load_mongo.py)."""
    return {
        "timestamp": r["obs_hour_utc"],
        "meta": {"zoneId": r["location_id"], "borough": r["borough"]},
        "localDate": r["local_date"].isoformat(),
        "localHour": r["local_hour"],
        "isoDayOfWeek": r["iso_dow"],
        **hourly_fields(r["pickups"], r["dropoffs"], r["fare_sum"], r["fare_trip_count"],
                        r["distance_sum"], r["distance_trip_count"],
                        r["duration_sum_s"], r["duration_trip_count"]),
    }


def build_mongo(db, name: str, timeseries: bool) -> tuple[float, int]:
    """Load the rows into a fresh collection and add indexes equivalent to
    PostgreSQL's: (zone, time) like the primary key, time alone like the
    obs_hour index, and (weekday, hour). Returns (load ms, documents)."""
    db.drop_collection(name)
    if timeseries:
        db.create_collection(name, timeseries={
            "timeField": "timestamp", "metaField": "meta", "granularity": "hours"})
    else:
        db.create_collection(name)
    coll = db[name]
    docs, batch = 0, []
    with pg_connect() as reader:
        t0 = time.perf_counter()
        for r in source_rows(reader):
            batch.append(to_document(r))
            if len(batch) == BATCH:
                coll.insert_many(batch, ordered=False)
                docs += len(batch)
                batch = []
        if batch:
            coll.insert_many(batch, ordered=False)
            docs += len(batch)
        coll.create_index([("meta.zoneId", ASCENDING), ("timestamp", ASCENDING)])
        coll.create_index([("timestamp", ASCENDING)])
        coll.create_index([("isoDayOfWeek", ASCENDING), ("localHour", ASCENDING)])
        load_ms = (time.perf_counter() - t0) * 1000
    return load_ms, docs


def pg_sizes(conn, relation: str) -> tuple[int, int]:
    """Data and index size in bytes of a table or materialised view."""
    return conn.execute("SELECT pg_table_size(%s::regclass), pg_indexes_size(%s::regclass)",
                        (relation, relation)).fetchone()


def mongo_sizes(db, name: str) -> tuple[int | None, int | None]:
    """Storage and index size in bytes. For a time-series collection MongoDB
    reports its internal buckets, which is the space it really uses."""
    try:
        stats = next(db[name].aggregate([{"$collStats": {"storageStats": {}}}]))["storageStats"]
    except Exception:
        try:
            stats = db.command("collStats", name)
        except Exception:
            return None, None
    return int(stats.get("storageSize", 0)), int(stats.get("totalIndexSize", 0))


# --- the questions, written once per database --------------------------------

def pg_queries(zone: int) -> dict[str, tuple[str, dict]]:
    t = PG_TABLE
    return {
        "Q1 one zone, one hour": (
            f"SELECT location_id, pickups, dropoffs FROM {t} "
            "WHERE location_id = %(zone)s AND obs_hour = %(hour)s",
            {"zone": zone, "hour": HOUR}),
        "Q2 one zone, seven days": (
            f"SELECT obs_hour_utc, pickups, dropoffs FROM {t} "
            "WHERE location_id = %(zone)s AND obs_hour >= %(start)s AND obs_hour < %(end)s "
            "ORDER BY obs_hour",
            {"zone": zone, "start": WEEK[0], "end": WEEK[1]}),
        "Q3 every zone, one month": (
            f"SELECT location_id, sum(pickups) AS pickups, sum(dropoffs) AS dropoffs, "
            "sum(fare_sum) AS fare_sum, sum(fare_trip_count) AS fare_trip_count "
            f"FROM {t} WHERE obs_hour >= %(start)s AND obs_hour < %(end)s "
            "GROUP BY location_id ORDER BY location_id",
            {"start": MONTH[0], "end": MONTH[1]}),
        "Q4 top 10 zones, one month": (
            f"SELECT location_id, sum(pickups) AS pickups FROM {t} "
            "WHERE obs_hour >= %(start)s AND obs_hour < %(end)s "
            "GROUP BY location_id ORDER BY pickups DESC, location_id LIMIT 10",
            {"start": MONTH[0], "end": MONTH[1]}),
    }


def mongo_queries(zone: int) -> dict[str, dict]:
    """The same questions as a find or an aggregate, in MongoDB's own terms."""
    month = {"timestamp": {"$gte": utc(MONTH[0]), "$lt": utc(MONTH[1])}}
    return {
        "Q1 one zone, one hour": {"find": {
            "filter": {"meta.zoneId": zone, "timestamp": utc(HOUR)},
            "projection": {"_id": 0, "meta.zoneId": 1, "pickups": 1, "dropoffs": 1}}},
        "Q2 one zone, seven days": {"find": {
            "filter": {"meta.zoneId": zone,
                       "timestamp": {"$gte": utc(WEEK[0]), "$lt": utc(WEEK[1])}},
            "projection": {"_id": 0, "timestamp": 1, "pickups": 1, "dropoffs": 1},
            "sort": [("timestamp", ASCENDING)]}},
        "Q3 every zone, one month": {"aggregate": [
            {"$match": month},
            {"$group": {"_id": "$meta.zoneId", "pickups": {"$sum": "$pickups"},
                        "dropoffs": {"$sum": "$dropoffs"}, "fare_sum": {"$sum": "$fareSum"},
                        "fare_trip_count": {"$sum": "$fareTripCount"}}},
            {"$sort": {"_id": 1}}]},
        "Q4 top 10 zones, one month": {"aggregate": [
            {"$match": month},
            {"$group": {"_id": "$meta.zoneId", "pickups": {"$sum": "$pickups"}}},
            {"$sort": {"pickups": -1, "_id": 1}},
            {"$limit": 10}]},
    }


def flow_queries(zone: int, day_type: str, time_bucket: str) -> tuple[tuple[str, dict], dict]:
    """Q5 for both databases: (PostgreSQL SQL and parameters, MongoDB find)."""
    month = MONTH[0].date()
    sql = ("SELECT dest_location_id, trips FROM od_summary "
           "WHERE month = %(month)s AND day_type = %(day_type)s "
           "AND time_bucket = %(bucket)s AND origin_location_id = %(zone)s "
           "ORDER BY trips DESC, dest_location_id LIMIT 10")
    params = {"month": month, "day_type": day_type, "bucket": time_bucket, "zone": zone}
    find = {"find": {
        "filter": {"originZoneId": zone, "month": f"{month:%Y-%m}",
                   "dayType": day_type, "timeBucket": time_bucket},
        "projection": {"_id": 0, "destinations.zoneId": 1, "destinations.trips": 1}}}
    return (sql, params), find


def run_pg(conn, sql: str, params: dict) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()


def run_mongo(coll, query: dict) -> list[dict]:
    if "find" in query:
        q = query["find"]
        cursor = coll.find(q["filter"], q["projection"])
        if "sort" in q:
            cursor = cursor.sort(q["sort"])
        return list(cursor)
    return list(coll.aggregate(query["aggregate"]))


# --- comparing answers --------------------------------------------------------

def normalise(name: str, rows: list[dict], store: str) -> list[tuple]:
    """Each store's answer as plain tuples, so the stores can be compared."""
    mongo = store != "postgres"
    if name == FLOW_QUERY:
        if mongo:
            return [(d["zoneId"], d["trips"]) for doc in rows for d in doc["destinations"]]
        return [(r["dest_location_id"], r["trips"]) for r in rows]
    out = []
    for r in rows:
        if name.startswith("Q1"):
            zone = r["meta"]["zoneId"] if mongo else r["location_id"]
            out.append((zone, r["pickups"], r["dropoffs"]))
        elif name.startswith("Q2"):
            ts = r["timestamp"] if mongo else r["obs_hour_utc"]
            out.append((ts.astimezone(UTC), r["pickups"], r["dropoffs"]))
        elif name.startswith("Q3"):
            zone = r["_id"] if mongo else r["location_id"]
            out.append((zone, int(r["pickups"]), int(r["dropoffs"]),
                        float(r["fare_sum"]), int(r["fare_trip_count"])))
        else:
            zone = r["_id"] if mongo else r["location_id"]
            out.append((zone, int(r["pickups"])))
    return out


def same_answer(a: list[tuple], b: list[tuple]) -> bool:
    """Equal row by row. Money sums are compared with a tiny tolerance:
    PostgreSQL adds exact decimals, MongoDB adds floating-point numbers."""
    if len(a) != len(b):
        return False
    for row_a, row_b in zip(a, b):
        if len(row_a) != len(row_b):
            return False
        for x, y in zip(row_a, row_b):
            if isinstance(x, float) or isinstance(y, float):
                if not math.isclose(float(x), float(y), rel_tol=1e-9, abs_tol=0.005):
                    return False
            elif x != y:
                return False
    return True


# --- timing and plans ---------------------------------------------------------

def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile: the smallest value with at least p% of the
    values at or below it."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def timed(fn, runs: int) -> tuple[list, dict]:
    """One cold run, then `runs` timed runs. Returns (answer, timings in ms)."""
    t0 = time.perf_counter()
    answer = fn()
    cold = (time.perf_counter() - t0) * 1000
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        times.append((time.perf_counter() - t0) * 1000)
    return answer, {"cold_ms": cold, "median_ms": statistics.median(times),
                    "p95_ms": percentile(times, 95)}


def pg_plan(conn, sql: str, params: dict) -> str:
    rows = conn.execute(f"EXPLAIN (ANALYZE, BUFFERS) {sql}", params).fetchall()
    return "\n".join(r[0] for r in rows)


def mongo_plan(db, name: str, query: dict) -> str:
    if "find" in query:
        q = query["find"]
        cmd = {"find": name, "filter": q["filter"], "projection": q["projection"]}
        if "sort" in q:
            cmd["sort"] = dict(q["sort"])
    else:
        cmd = {"aggregate": name, "pipeline": query["aggregate"], "cursor": {}}
    plan = db.command("explain", cmd, verbosity="executionStats")
    for noise in ("serverInfo", "serverParameters", "command", "ok", "$clusterTime", "operationTime"):
        plan.pop(noise, None)
    return json.dumps(plan, default=str, indent=1)


# --- running it -----------------------------------------------------------------

class Results:
    """Collects one result per store and question, checks the stores agree,
    and saves everything in one transaction."""

    def __init__(self, conn, db, runs: int):
        self.conn, self.db, self.runs = conn, db, runs
        self.rows = []

    def question(self, name: str, stores: dict) -> None:
        """Time one question in every store. `stores` maps a store name to
        (run function, plan function, (data bytes, index bytes), load ms)."""
        answers, medians = {}, []
        for store, (run, plan, (data, index), load_ms) in stores.items():
            answer, t = timed(run, self.runs)
            answers[store] = normalise(name, answer, store)
            medians.append(f"{store} {t['median_ms']:7.2f}")
            self.rows.append((store, name, t, data, index, load_ms, plan()))
        pg = answers["postgres"]
        if not pg:
            sys.exit(f"{name}: no rows; are the months loaded, and does the zone have trips?")
        for store, answer in answers.items():
            if not same_answer(answer, pg):
                sys.exit(f"{name}: {store} gave a different answer from PostgreSQL; nothing saved")
        print(f"  {name:<36} median ms: {'  '.join(medians)}   ({len(pg)} rows, answers match)")

    def save(self) -> None:
        with self.conn.transaction():
            for store, name, t, data, index, load_ms, plan in self.rows:
                self.conn.execute(
                    """INSERT INTO benchmark_run (store, query_name, runs, cold_ms, median_ms, p95_ms,
                                                  storage_bytes, index_bytes, load_ms, plan_output)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (store, name, self.runs, round(t["cold_ms"], 3), round(t["median_ms"], 3),
                     round(t["p95_ms"], 3), data, index,
                     None if load_ms is None else round(load_ms, 3), plan))
        print(f"\nsaved {len(self.rows)} results to benchmark_run")


def benchmark(runs: int, zone: int, day_type: str, time_bucket: str) -> None:
    db = mongo_db()
    with pg_connect(autocommit=True) as conn:
        print("building the three hourly stores from zone_hour_observation")
        load, size, count = {}, {}, {}
        load["postgres"], count["postgres"] = build_postgres(conn)
        size["postgres"] = pg_sizes(conn, PG_TABLE)
        for store, name, ts in (("mongo_collection", MONGO_COLLECTION, False),
                                ("mongo_timeseries", MONGO_TIMESERIES, True)):
            load[store], count[store] = build_mongo(db, name, ts)
            size[store] = mongo_sizes(db, name)
        for store in HOURLY_STORES:
            data, index = size[store]
            print(f"  {store:<17} {count[store]:>9,} rows  load {load[store] / 1000:6.1f}s  "
                  f"data {mb(data)}  indexes {mb(index)}")
        if len(set(count.values())) != 1:
            sys.exit(f"stores hold different row counts: {count}")

        results = Results(conn, db, runs)
        print(f"\nrunning each query once cold, then {runs} times")
        collections = {"mongo_collection": MONGO_COLLECTION, "mongo_timeseries": MONGO_TIMESERIES}
        pg_q, mongo_q = pg_queries(zone), mongo_queries(zone)
        for name, (sql, params) in pg_q.items():
            # default arguments bind each lambda to this question's values
            stores = {"postgres": (lambda s=sql, p=params: run_pg(conn, s, p),
                                   lambda s=sql, p=params: pg_plan(conn, s, p),
                                   size["postgres"], load["postgres"])}
            for store, coll in collections.items():
                q = mongo_q[name]
                stores[store] = (lambda c=coll, q=q: run_mongo(db[c], q),
                                 lambda c=coll, q=q: mongo_plan(db, c, q),
                                 size[store], load[store])
            results.question(name, stores)

        (sql, params), find = flow_queries(zone, day_type, time_bucket)
        results.question(FLOW_QUERY, {
            "postgres": (lambda: run_pg(conn, sql, params), lambda: pg_plan(conn, sql, params),
                         pg_sizes(conn, "od_summary"), None),
            "mongo_collection": (lambda: run_mongo(db[OD], find), lambda: mongo_plan(db, OD, find),
                                 mongo_sizes(db, OD), None),
        })
        results.save()


def mb(n: int | None) -> str:
    return "      –" if n is None else f"{n / 1_048_576:6.1f} MB"


def explain_summary(month: str) -> None:
    start = parse_month(month)
    params = {"start": start, "end": next_month(start)}
    with pg_connect(autocommit=True) as conn:
        with conn.transaction(force_rollback=True):
            conn.execute("DELETE FROM zone_hour_observation "
                         "WHERE obs_hour >= %(start)s AND obs_hour < %(end)s", params)
            for (line,) in conn.execute(f"EXPLAIN (ANALYZE, BUFFERS) {GRID_SQL}", params):
                print(line)
    print(f"\n(EXPLAIN ANALYZE of the {month} summary build; rolled back, nothing changed)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=50, help="timed runs per query (default 50)")
    ap.add_argument("--zone", type=int, default=DEFAULT_ZONE,
                    help=f"zone for Q1, Q2 and Q5 (default {DEFAULT_ZONE})")
    ap.add_argument("--day-type", choices=["weekday", "weekend"], default="weekday",
                    help="day type for Q5 (default weekday)")
    ap.add_argument("--time-bucket", choices=["night", "am_peak", "midday", "pm_peak", "evening"],
                    default="pm_peak", help="time of day for Q5 (default pm_peak)")
    ap.add_argument("--explain-summary", metavar="YYYY-MM",
                    help="print EXPLAIN ANALYZE of one month's summary build instead")
    args = ap.parse_args()
    if args.explain_summary:
        explain_summary(args.explain_summary)
    elif args.runs < 1:
        ap.error("--runs must be at least 1")
    else:
        benchmark(args.runs, args.zone, args.day_type, args.time_bucket)


if __name__ == "__main__":
    main()
