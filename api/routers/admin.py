"""Administration routes (admin role only).

Served at /admin/... here and at /api/admin/... from the website.

  GET /admin/imports          every import batch with its counts and its
                              reject and warning reasons
  GET /admin/rejected         one batch's rejected rows, 50 per page,
                              optionally for one reason code
  GET /admin/reconciliation   recent PostgreSQL-vs-MongoDB reconciliation runs
  GET /admin/orphaned-views   saved views whose owner no longer exists, checked now
  DELETE /admin/orphaned-views   delete them
  GET /admin/plan-seals       every saved plan version's hash chain, checked now
  GET /admin/benchmarks       the latest benchmark run (etl/benchmark.py)
  GET /admin/load-tests       the latest load test run (etl/load_test.py)
  GET /admin/stores           what each database holds and which page reads
                              it: PostgreSQL's main tables and monthly trip
                              partitions, MongoDB's collections

Only admins get here: api/main.py adds every route in this file with the
admin_only check (tests/test_auth.py checks that).

The query functions take a connection, so tests can call them directly
without starting the web server.
"""
import json
import math
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import sql
from psycopg.rows import dict_row

from .. import dashboard, flows, planner, saved_views
from ..db import get_pg, mongo

router = APIRouter(prefix="/admin", tags=["admin"])

PAGE_SIZE = 50


# --- queries -------------------------------------------------------------

def list_imports(conn) -> list[dict]:
    """Every import batch, oldest month first, with its reasons attached:
    `rejects` (R codes, from rejected_trip) and `warnings` (W codes, from
    trip_warning), each [{code, description, rows}] with the largest first."""
    with conn.cursor(row_factory=dict_row) as cur:
        batches = cur.execute(
            """SELECT import_batch_id, to_char(file_month, 'YYYY-MM') AS month,
                      source_file, left(checksum_sha256, 16) AS checksum_prefix,
                      rows_read, rows_accepted, rows_rejected, rows_warned,
                      status, started_at, finished_at
               FROM import_batch
               ORDER BY file_month""").fetchall()
        rejects = cur.execute(
            """SELECT r.import_batch_id, r.reason_code AS code, v.description,
                      count(*)::int AS rows
               FROM rejected_trip r
               JOIN validation_code v ON v.code = r.reason_code
               GROUP BY 1, 2, 3
               ORDER BY 1, rows DESC, code""").fetchall()
        warnings = cur.execute(
            """SELECT w.import_batch_id, w.code, v.description, count(*)::int AS rows
               FROM trip_warning w
               JOIN validation_code v USING (code)
               GROUP BY 1, 2, 3
               ORDER BY 1, rows DESC, code""").fetchall()

    by_batch = {b["import_batch_id"]: {**b, "rejects": [], "warnings": []} for b in batches}
    for key, rows in (("rejects", rejects), ("warnings", warnings)):
        for r in rows:
            batch = by_batch.get(r.pop("import_batch_id"))
            if batch is not None:
                batch[key].append(r)
    return list(by_batch.values())


def list_rejected(conn, batch_id: int, code: str | None = None, page: int = 1) -> dict:
    """One page of a batch's rejected rows, in file order. Raises LookupError
    if the batch doesn't exist.

    The raw numbers are returned as text: a rejected row can hold NaN or
    infinity (that is what R9 catches), which JSON can't represent."""
    if conn.execute("SELECT 1 FROM import_batch WHERE import_batch_id = %s",
                    (batch_id,)).fetchone() is None:
        raise LookupError(f"import batch {batch_id} not found")
    params = {"batch": batch_id, "code": code,
              "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}
    with conn.cursor(row_factory=dict_row) as cur:
        total = cur.execute(
            """SELECT count(*)::int AS n FROM rejected_trip
               WHERE import_batch_id = %(batch)s
                 AND (%(code)s::text IS NULL OR reason_code = %(code)s)""",
            params).fetchone()["n"]
        rows = cur.execute(
            """SELECT source_row_number, reason_code AS code,
                      vendor_id::text, pickup_ts, dropoff_ts,
                      pickup_location_id::text, dropoff_location_id::text,
                      payment_type_id::text, passenger_count::text,
                      trip_distance::text, fare_amount::text, total_amount::text
               FROM rejected_trip
               WHERE import_batch_id = %(batch)s
                 AND (%(code)s::text IS NULL OR reason_code = %(code)s)
               ORDER BY source_row_number
               LIMIT %(limit)s OFFSET %(offset)s""",
            params).fetchall()
    return {"batch_id": batch_id, "code": code, "page": page, "page_size": PAGE_SIZE,
            "total": total, "pages": max(1, math.ceil(total / PAGE_SIZE)), "rows": rows}


def list_reconciliation(conn, limit: int = 50) -> list[dict]:
    """The most recent reconciliation runs, newest first."""
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            """SELECT reconciliation_run_id, to_char(month, 'YYYY-MM') AS month,
                      started_at, finished_at, passed,
                      pg_hour_rows, mongo_hour_docs, pg_pickups, mongo_pickups,
                      pg_dropoffs, mongo_dropoffs, zone_hour_mismatches,
                      od_mismatches, details
               FROM reconciliation_run
               ORDER BY reconciliation_run_id DESC
               LIMIT %s""",
            (limit,)).fetchall()


def plan_summary(store: str, plan: str | None) -> str | None:
    """How a database ran a benchmark query, in a few words, from its saved
    query plan: the way it found the data and how much it read. PostgreSQL
    plans are EXPLAIN (ANALYZE, BUFFERS) text, read in 8 kB pages; MongoDB
    plans are explain("executionStats") JSON, read in documents, or in
    compressed buckets for a time-series collection."""
    if not plan:
        return None
    if store == "postgres":
        nodes = plan
        how = ("full table scan" if "Seq Scan" in nodes else "bitmap index scan" if "Bitmap" in nodes
               else "index-only scan" if "Index Only Scan" in nodes else "index scan" if "Index Scan" in nodes else "scan")
        if "Parallel" in nodes:
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


def latest_benchmark(conn) -> dict:
    """Every result of the most recent benchmark run (one row per store and
    query), with when it ran. Empty if the benchmark hasn't been run.

    Each result says which data it measured: Q1 to Q4 use the hourly zone
    summaries, Q5 the Flow Explorer's destination lists, Q6 and Q7 the
    Analytical Dashboard's stores (etl/benchmark.py)."""
    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(
            """SELECT store, query_name, runs, cold_ms, median_ms, p95_ms,
                      storage_bytes, index_bytes, load_ms, plan_output, run_at,
                      CASE left(query_name, 2) WHEN 'Q5' THEN 'destinations'
                           WHEN 'Q6' THEN 'dashboard' WHEN 'Q7' THEN 'dashboard'
                           ELSE 'hourly' END AS data
               FROM benchmark_run
               WHERE run_at = (SELECT max(run_at) FROM benchmark_run)
               ORDER BY query_name, store""").fetchall()
    run_at = rows[0]["run_at"] if rows else None
    return {"run_at": run_at, "results": [{**{k: v for k, v in r.items() if k != "run_at"},
                                           "plan_summary": plan_summary(r["store"], r["plan_output"])} for r in rows]}


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
    run_at = rows[0]["run_at"] if rows else None
    return {"run_at": run_at, "results": [{k: v for k, v in r.items() if k != "run_at"} for r in rows]}


# The tables worth showing, in the order the data flows through them: the
# name, what kind of relation, what one row is, and what in the app reads it.
PG_TABLES = [
    ("import_batch", "table", "one imported file, with its checksum", ["Data health"]),
    ("trip", "partitioned table", "one taxi trip", ["every summary is built from it"]),
    ("rejected_trip", "table", "a row that failed a rule, with the rule", ["Data pipeline"]),
    ("trip_warning", "table", "a suspicious value on a kept trip", ["Data pipeline"]),
    ("taxi_zone", "table", "one TLC zone and its shape (PostGIS)", ["every map"]),
    ("zone_hour_observation", "table", "one zone in one hour", ["Allocation Planner", "copied to MongoDB"]),
    ("od_summary", "materialized view", "trips between two zones", ["copied to MongoDB", "Performance"]),
    ("allocation_plan_version", "table", "one saved plan version, sealed by a hash chain", ["Saved plans"]),
]

# The collections, in the same form. Which page reads which is chosen in
# api/dashboard.py (source), api/flows.py and api/saved_views.py. The API's
# MongoDB login may only read documents (etl/load_mongo.py), not list
# collections, so they are named here.
MONGO_COLLECTIONS = [
    (dashboard.DAILY, "pre-summed", "one zone on one day", ["Zone maps"]),
    (dashboard.COLLECTION, "time-series", "one zone in one hour",
     ["Zone maps with hours filtered", "comparing zones", "Planner check"]),
    (dashboard.BOROUGH_HOURLY, "pre-summed", "one borough in one hour", ["Daily trends", "Allocation Planner"]),
    (flows.COLLECTION, "snapshot", "one zone's top 10 destinations for a month, day type and time band", ["Flow Explorer"]),
    (saved_views.COLLECTION, "app data", "one saved view", ["Views menu"]),
]


def stores(conn, db) -> dict:
    """What each database holds and what reads it, for the Data pipeline
    page. Large tables use PostgreSQL's row estimate (pg_class.reltuples,
    kept up to date by ANALYZE), instant even for 11 million trips; smaller
    ones, which ANALYZE may not have reached yet, are counted exactly."""
    with conn.cursor(row_factory=dict_row) as cur:
        sizes = {r["name"]: r for r in cur.execute(
            """SELECT c.relname AS name, greatest(c.reltuples, 0)::bigint AS rows,
                      pg_total_relation_size(c.oid) AS bytes
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = ANY(%s)""",
            ([name for name, *_ in PG_TABLES],)).fetchall()}
        partitions = cur.execute(
            """SELECT c.relname AS name, greatest(c.reltuples, 0)::bigint AS rows,
                      pg_total_relation_size(c.oid) AS bytes
               FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
               WHERE i.inhparent = 'trip'::regclass
               ORDER BY c.relname""").fetchall()
        for name, found in sizes.items():
            if found["rows"] < 1_000_000:
                found["rows"] = cur.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(sql.Identifier(name))).fetchone()["n"]
    tables = []
    for name, kind, one, used_by in PG_TABLES:
        found = sizes.get(name)
        if name == "trip":   # the parent holds no rows itself: its partitions do
            found = {"rows": sum(p["rows"] for p in partitions), "bytes": sum(p["bytes"] for p in partitions)}
        if found:
            tables.append({"name": name, "kind": kind, "one": one, "used_by": used_by,
                           "rows": found["rows"], "bytes": found["bytes"]})

    collections = [{"name": name, "kind": kind, "one": one, "used_by": used_by, "documents": db[name].count_documents({})}
                   for name, kind, one, used_by in MONGO_COLLECTIONS]
    return {"postgres": {"tables": tables, "partitions": partitions}, "mongo": collections}


# --- routes --------------------------------------------------------------

@router.get("/imports")
def imports(conn=Depends(get_pg)):
    """Import batches with accepted, rejected and warned counts and reasons."""
    return list_imports(conn)


@router.get("/rejected")
def rejected(batch: int,
             code: str | None = Query(None, pattern=r"^R[0-9]$"),
             page: int = Query(1, ge=1),
             conn=Depends(get_pg)):
    """Rejected rows of one batch, 50 per page, optionally one reason code."""
    try:
        return list_rejected(conn, batch, code, page)
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.get("/reconciliation")
def reconciliation(limit: int = Query(50, ge=1, le=500),
                   conn=Depends(get_pg)):
    """Recent reconciliation runs, newest first."""
    return list_reconciliation(conn, limit)


@router.get("/orphaned-views")
def orphaned_views(conn=Depends(get_pg)):
    """How many saved views there are, and which belong to users that no
    longer exist in PostgreSQL."""
    return saved_views.orphaned_views(mongo()[saved_views.COLLECTION], conn)


@router.delete("/orphaned-views")
def delete_orphaned_views(conn=Depends(get_pg)):
    """Delete the saved views whose owner no longer exists."""
    return {"deleted": saved_views.delete_orphaned_views(mongo()[saved_views.COLLECTION], conn)}


@router.get("/plan-seals")
def plan_seals(conn=Depends(get_pg)):
    """How many saved plan versions there are, and any whose contents no
    longer match the hash they were sealed with."""
    return planner.check_seals(conn)


@router.get("/benchmarks")
def benchmarks(conn=Depends(get_pg)):
    """The latest benchmark run: timings, sizes and query plans per store."""
    return latest_benchmark(conn)


@router.get("/load-tests")
def load_tests(conn=Depends(get_pg)):
    """The latest load test: requests a second and response times per
    question at each number of simultaneous users."""
    return latest_load_test(conn)


@router.get("/stores")
def stores_route(conn=Depends(get_pg)):
    """PostgreSQL's main tables and monthly trip partitions, and MongoDB's
    collections, each with what one row is, what reads it and how many there are."""
    return stores(conn, mongo())
