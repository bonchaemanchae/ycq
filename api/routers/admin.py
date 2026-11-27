"""Administration routes (admin role only), for the Data health page.

Served at /admin/... here and at /api/admin/... from the website.

  GET /admin/imports          every import batch with its counts and its
                              reject and warning reasons
  GET /admin/reconciliation   recent PostgreSQL-vs-MongoDB reconciliation runs
  GET /admin/orphaned-views   saved views whose owner no longer exists, checked now
  DELETE /admin/orphaned-views   delete them
  GET /admin/plan-seals       every saved plan version's hash chain, checked now

The performance results (benchmark and load test) are printed by
etl/results.py rather than shown in the website.

Only admins get here: api/main.py adds every route in this file with the
admin_only check (tests/test_auth.py checks that).

The query functions take a connection, so tests can call them directly
without starting the web server.
"""
from fastapi import APIRouter, Depends, Query
from psycopg.rows import dict_row

from .. import planner, saved_views
from ..db import get_pg, mongo

router = APIRouter(prefix="/admin", tags=["admin"])


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
def imports(conn=Depends(get_pg)):
    """Import batches with accepted, rejected and warned counts and reasons."""
    return list_imports(conn)


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
