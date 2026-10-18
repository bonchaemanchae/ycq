"""Administration routes (admin role only).

Served at /admin/... here and at /api/admin/... from the website.

  GET /admin/imports          every import batch with its counts and its
                              reject and warning reasons
  GET /admin/rejected         one batch's rejected rows, 50 per page,
                              optionally for one reason code
  GET /admin/reconciliation   recent PostgreSQL-vs-MongoDB reconciliation runs

Benchmark results (benchmark_run) are added with the benchmark script.

The query functions take a connection, so tests can call them directly
without starting the web server.
"""
import math

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.rows import dict_row

from ..auth import User, current_user
from ..db import get_pg

router = APIRouter(prefix="/admin", tags=["admin"])

PAGE_SIZE = 50


def require_admin(user: User = Depends(current_user)) -> User:
    """Only users with the admin role may use these routes (403 otherwise)."""
    if "admin" not in user.roles:
        raise HTTPException(403, "admin role required")
    return user


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


# --- routes --------------------------------------------------------------

@router.get("/imports")
def imports(conn=Depends(get_pg), _: User = Depends(require_admin)):
    """Import batches with accepted, rejected and warned counts and reasons."""
    return list_imports(conn)


@router.get("/rejected")
def rejected(batch: int,
             code: str | None = Query(None, pattern=r"^R[0-9]$"),
             page: int = Query(1, ge=1),
             conn=Depends(get_pg), _: User = Depends(require_admin)):
    """Rejected rows of one batch, 50 per page, optionally one reason code."""
    try:
        return list_rejected(conn, batch, code, page)
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.get("/reconciliation")
def reconciliation(limit: int = Query(50, ge=1, le=500),
                   conn=Depends(get_pg), _: User = Depends(require_admin)):
    """Recent reconciliation runs, newest first."""
    return list_reconciliation(conn, limit)
