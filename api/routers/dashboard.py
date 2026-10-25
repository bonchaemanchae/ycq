"""Activity Dashboard routes. The MongoDB pipelines live in api/dashboard.py.

Served at /dashboard/... here and at /api/dashboard/... from the website.
Every activity route takes the same filters as query parameters, named like a
saved view's filters: dateFrom, dateTo, weekdays (repeat it, e.g.
weekdays=1&weekdays=2), hourFrom, hourTo, boroughs, zoneIds and metric.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from psycopg.rows import dict_row

from .. import dashboard
from ..auth import User, current_user
from ..dashboard import ActivityFilters, CompareFilters, SeriesFilters
from ..db import get_pg, mongo

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _coll():
    return mongo()[dashboard.COLLECTION]


def zone_names(conn) -> dict[int, str]:
    """location_id -> zone name, for zones with a map shape."""
    return dict(conn.execute("SELECT location_id, zone_name FROM taxi_zone WHERE geom IS NOT NULL"))


@router.get("")
def summary(f: Annotated[ActivityFilters, Query()], conn=Depends(get_pg)):
    """Totals (pickups, drop-offs, average fare, distance and duration) and
    every zone with its rank, share and imbalance, for the map and tables."""
    return dashboard.summary(_coll(), f, zone_names(conn))


@router.get("/series")
def series(f: Annotated[SeriesFilters, Query()]):
    """Pickups and drop-offs per hour or per day, with a moving average
    (24 hours or 7 days)."""
    return dashboard.series(_coll(), f)


@router.get("/weekdays")
def weekdays(f: Annotated[ActivityFilters, Query()]):
    """Average pickups per day for each weekday, and for each weekday and hour."""
    return dashboard.weekdays(_coll(), f)


@router.get("/compare")
def compare(f: Annotated[CompareFilters, Query()], conn=Depends(get_pg)):
    """One to three zones side by side, including the median and 90th
    percentile of their hourly pickups and their peak hour."""
    return dashboard.compare_zones(_coll(), f, zone_names(conn))


@router.get("/context")
def context(conn=Depends(get_pg), user: User = Depends(current_user)):
    """What the page needs around the filters: the loaded date range, the
    latest import and the caller's most recent plans (all PostgreSQL)."""
    with conn.cursor(row_factory=dict_row) as cur:
        span = cur.execute(
            """SELECT min(file_month) AS first_month,
                      (max(file_month) + interval '1 month - 1 day')::date AS last_day
               FROM import_batch WHERE status = 'completed'""").fetchone()
        latest = cur.execute(
            """SELECT to_char(file_month, 'YYYY-MM') AS month, rows_accepted, finished_at
               FROM import_batch WHERE status = 'completed'
               ORDER BY finished_at DESC NULLS LAST LIMIT 1""").fetchone()
        plans = cur.execute(
            """SELECT allocation_plan_id, name, updated_at, latest_version, fleet_size,
                      iso_dow, start_hour, end_hour
               FROM v_plan_summary WHERE owner_user_id = %s
               ORDER BY updated_at DESC LIMIT 5""",
            (user.user_id,)).fetchall()
    return {
        "dateFrom": span["first_month"].isoformat() if span["first_month"] else None,
        "dateTo": span["last_day"].isoformat() if span["last_day"] else None,
        "latestImport": latest,
        "recentPlans": plans,
    }
