"""Allocation planner: score zones, split the fleet, save plan versions.

Plain functions that take an open psycopg connection, so the FastAPI routes
only have to parse the request, call one of these and return the result.

    params = PlanParams(fleet_size=50, iso_dow=1, start_hour=7, end_hour=9,
                        borough_ids=[4])
    rows = preview(conn, params)                      # nothing saved
    version_no = save_version(conn, owner, plan_id, params,
                              overrides={(8, 161): 7})  # (hour, zone) -> taxis

Scoring, for every zone and hour on the chosen weekday (all loaded months):
  pickup activity   average pickups that hour
  imbalance         average pickups minus drop-offs (taxis leave faster than they arrive)
  consistency       1 / (1 + coefficient of variation of pickups)
  median fare       from zone_weekday_hour_fare
Each metric becomes 0-1 within its hour with cume_dist(), the weights combine
them, the best max_zones_per_hour zones are kept, and the fleet is split in
proportion to score by the largest-remainder method, so every hour adds up to
exactly fleet_size (the rule the 006/011 triggers enforce on save).
"""
import math
import statistics
import time
from dataclasses import dataclass, field
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row


class PlanError(ValueError):
    """The request can't be saved as asked (shown to the user as a 400)."""


class PlanNotFound(LookupError):
    """No such plan, or it belongs to someone else (shown as a 404)."""


@dataclass
class PlanParams:
    fleet_size: int
    iso_dow: int                      # 1 = Monday
    start_hour: int                   # inclusive
    end_hour: int                     # inclusive, as in allocation_plan_version
    borough_ids: list[int]
    max_zones_per_hour: int = 10
    min_sample: int = 30              # pickups observed in that zone and hour
    w_pickup: Decimal = Decimal("0.50")
    w_imbalance: Decimal = Decimal("0.25")
    w_consistency: Decimal = Decimal("0.15")
    w_fare: Decimal = Decimal("0.10")
    note: str | None = None
    hours: list[int] = field(init=False)

    def __post_init__(self):
        self.hours = list(range(self.start_hour, self.end_hour + 1))


# Deferred constraint triggers from sql/006, sql/011 and sql/012
PLAN_TRIGGERS = "allocation_result_hour_total, allocation_plan_version_hours, allocation_result_zone"

# Per zone and hour on the chosen weekday. zone_hour_observation has a row for
# every zone and hour (zeros included), so count(*) is the number of days
# observed. compare_stores() runs the same statistics on MongoDB.
STATS_SQL = """
    SELECT h.location_id,
           h.local_hour                      AS hour,
           count(*)::int                     AS days,
           sum(h.pickups)::int               AS trips,
           avg(h.pickups)                    AS avg_pickups,
           avg(h.pickups - h.dropoffs)       AS avg_imbalance,
           stddev_pop(h.pickups)             AS sd_pickups
    FROM zone_hour_observation h
    JOIN taxi_zone z USING (location_id)
    WHERE h.iso_dow = %(iso_dow)s
      AND h.local_hour BETWEEN %(start_hour)s AND %(end_hour)s
      AND z.borough_id = ANY(%(borough_ids)s)
    GROUP BY h.location_id, h.local_hour
"""

SCORE_SQL = """
WITH stats AS (""" + STATS_SQL + """),
candidates AS (
    SELECT s.*,
           -- 1 / (1 + coefficient of variation); a zone with no pickups gets 0
           CASE WHEN s.avg_pickups > 0
                THEN 1 / (1 + s.sd_pickups / s.avg_pickups) ELSE 0 END    AS consistency,
           f.median_fare
    FROM stats s
    LEFT JOIN zone_weekday_hour_fare f
           ON f.location_id = s.location_id
          AND f.iso_dow = %(iso_dow)s
          AND f.local_hour = s.hour
    WHERE s.trips >= %(min_sample)s
),
percentiles AS (
    -- Each metric as a 0-1 percentile within its hour. A missing median fare
    -- (no metered trips) counts as 0, so it ranks lowest on fare.
    SELECT *,
           cume_dist() OVER (PARTITION BY hour ORDER BY avg_pickups)              AS pct_pickup,
           cume_dist() OVER (PARTITION BY hour ORDER BY avg_imbalance)            AS pct_imbalance,
           cume_dist() OVER (PARTITION BY hour ORDER BY consistency)              AS pct_consistency,
           cume_dist() OVER (PARTITION BY hour ORDER BY coalesce(median_fare, 0)) AS pct_fare
    FROM candidates
),
scored AS (
    SELECT *,
           round((  %(w_pickup)s      * pct_pickup
                  + %(w_imbalance)s   * pct_imbalance
                  + %(w_consistency)s * pct_consistency
                  + %(w_fare)s        * pct_fare
                 )::numeric, 5) AS score
    FROM percentiles
),
ranked AS (
    SELECT *,
           row_number() OVER (PARTITION BY hour ORDER BY score DESC, location_id) AS rank
    FROM scored
),
shares AS (
    SELECT *,
           rank <= %(max_zones)s AS selected,
           CASE WHEN rank <= %(max_zones)s THEN
               %(fleet_size)s * score
               / sum(score) FILTER (WHERE rank <= %(max_zones)s) OVER (PARTITION BY hour)
           END AS exact_share
    FROM ranked
),
floored AS (
    SELECT *,
           floor(exact_share)::int AS base,
           %(fleet_size)s - sum(floor(exact_share)) OVER (PARTITION BY hour, selected) AS leftover,
           row_number() OVER (PARTITION BY hour, selected
                              ORDER BY exact_share - floor(exact_share) DESC, score DESC,
                                       location_id) AS remainder_rank
    FROM shares
)
SELECT f.hour,
       f.location_id,
       z.zone_name,
       b.name                                         AS borough,
       f.rank,
       f.score,
       f.trips                                        AS sample_size,
       f.selected,
       CASE WHEN f.selected
            THEN f.base + (f.remainder_rank <= f.leftover)::int
            ELSE 0 END                                AS proposed_taxis,
       f.days,
       round(f.avg_pickups, 1)                        AS avg_pickups,
       round(f.avg_imbalance, 1)                      AS avg_imbalance,
       f.median_fare,
       round(f.pct_pickup::numeric, 3)                AS pct_pickup,
       round(f.pct_imbalance::numeric, 3)             AS pct_imbalance,
       round(f.pct_consistency::numeric, 3)           AS pct_consistency,
       round(f.pct_fare::numeric, 3)                  AS pct_fare,
       format('%%s pickups and net %%s per hour on average over %%s days, median fare %%s',
              round(f.avg_pickups, 1), round(f.avg_imbalance, 1), f.days,
              coalesce('$' || f.median_fare, 'unknown'))  AS reason
FROM floored f
JOIN taxi_zone z USING (location_id)
JOIN borough b USING (borough_id)
ORDER BY f.hour, f.rank
"""


def _sql_params(p: PlanParams) -> dict:
    return {
        "iso_dow": p.iso_dow, "start_hour": p.start_hour, "end_hour": p.end_hour,
        "borough_ids": p.borough_ids, "min_sample": p.min_sample,
        "max_zones": p.max_zones_per_hour, "fleet_size": p.fleet_size,
        "w_pickup": p.w_pickup, "w_imbalance": p.w_imbalance,
        "w_consistency": p.w_consistency, "w_fare": p.w_fare,
    }


def score(conn: psycopg.Connection, p: PlanParams) -> list[dict]:
    """Every eligible zone for every hour. selected=True rows are the proposal."""
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(SCORE_SQL, _sql_params(p)).fetchall()


def empty_hours(p: PlanParams, rows: list[dict]) -> list[int]:
    """Hours where no zone passed the filters, so nothing can be allocated."""
    covered = {r["hour"] for r in rows if r["selected"]}
    return [h for h in p.hours if h not in covered]


def preview(conn: psycopg.Connection, p: PlanParams) -> list[dict]:
    """The proposed allocation, without saving anything."""
    return [r for r in score(conn, p) if r["selected"]]


def save_version(conn: psycopg.Connection, owner_user_id: int, plan_id: int,
                 p: PlanParams, overrides: dict[tuple[int, int], int] | None = None) -> int:
    """Score again and save the result as the plan's next version.

    overrides maps (hour, location_id) to the analyst's final taxis. A zone
    outside the proposal can be added if it passed the filters. Every hour
    must still add up to fleet_size, or the whole save is rolled back.
    Returns the new version_no.
    """
    overrides = overrides or {}
    with conn.transaction():
        # Locking the plan row makes two saves of the same plan queue up, so
        # they can't both take the same version number.
        if conn.execute(
            """SELECT 1 FROM allocation_plan
               WHERE allocation_plan_id = %s AND owner_user_id = %s
               FOR UPDATE""",
            (plan_id, owner_user_id),
        ).fetchone() is None:
            raise PlanNotFound(f"plan {plan_id} not found")

        rows = score(conn, p)
        if missing := empty_hours(p, rows):
            raise PlanError(
                f"no zone has at least {p.min_sample} pickups at hour(s) "
                f"{', '.join(map(str, missing))}; lower the minimum sample or add boroughs")
        eligible = {(r["hour"], r["location_id"]) for r in rows}
        if unknown := sorted(set(overrides) - eligible):
            raise PlanError(f"zones not eligible for these settings: {unknown}")

        version_no = conn.execute(
            """SELECT coalesce(max(version_no), 0) + 1 FROM allocation_plan_version
               WHERE allocation_plan_id = %s""",
            (plan_id,),
        ).fetchone()[0]
        conn.execute(
            """INSERT INTO allocation_plan_version
                   (allocation_plan_id, version_no, fleet_size, iso_dow, start_hour, end_hour,
                    max_zones_per_hour, min_sample, w_pickup, w_imbalance, w_consistency,
                    w_fare, note)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (plan_id, version_no, p.fleet_size, p.iso_dow, p.start_hour, p.end_hour,
             p.max_zones_per_hour, p.min_sample, p.w_pickup, p.w_imbalance,
             p.w_consistency, p.w_fare, p.note),
        )
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO allocation_plan_version_borough
                       (allocation_plan_id, version_no, borough_id)
                   VALUES (%s, %s, %s)""",
                [(plan_id, version_no, b) for b in sorted(set(p.borough_ids))],
            )
            cur.executemany(
                """INSERT INTO allocation_result
                       (allocation_plan_id, version_no, hour, location_id, proposed_taxis,
                        final_taxis, score, rank, sample_size, reason)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                [
                    (plan_id, version_no, r["hour"], r["location_id"], r["proposed_taxis"],
                     overrides.get((r["hour"], r["location_id"]), r["proposed_taxis"]),
                     r["score"], r["rank"], r["sample_size"],
                     r["reason"] if r["selected"] else "added by analyst: " + r["reason"])
                    for r in rows
                    if r["selected"] or (r["hour"], r["location_id"]) in overrides
                ],
            )
        conn.execute(
            "UPDATE allocation_plan SET updated_at = now() WHERE allocation_plan_id = %s",
            (plan_id,),
        )
        # Run the deferred plan triggers now, so a bad edit fails here with a
        # clear message instead of at some later commit. Setting them back to
        # deferred keeps the next save in the same transaction working.
        try:
            conn.execute(f"SET CONSTRAINTS {PLAN_TRIGGERS} IMMEDIATE")
        except psycopg.errors.CheckViolation as e:
            raise PlanError(e.diag.message_primary) from e
        conn.execute(f"SET CONSTRAINTS {PLAN_TRIGGERS} DEFERRED")
    return version_no


# --- plan CRUD ---------------------------------------------------------------

def create_plan(conn: psycopg.Connection, owner_user_id: int, name: str) -> int:
    try:
        with conn.transaction():
            return conn.execute(
                """INSERT INTO allocation_plan (owner_user_id, name) VALUES (%s, %s)
                   RETURNING allocation_plan_id""",
                (owner_user_id, name.strip()),
            ).fetchone()[0]
    except psycopg.errors.UniqueViolation as e:
        raise PlanError(f"you already have a plan called {name.strip()!r}") from e
    except psycopg.errors.CheckViolation as e:
        raise PlanError("plan name can't be empty") from e


def list_plans(conn: psycopg.Connection, owner_user_id: int) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            "SELECT * FROM v_plan_summary WHERE owner_user_id = %s ORDER BY updated_at DESC",
            (owner_user_id,),
        ).fetchall()


def list_versions(conn: psycopg.Connection, owner_user_id: int, plan_id: int) -> list[dict]:
    """A plan's saved versions, newest first, with their settings and edit counts."""
    with conn.cursor(row_factory=dict_row) as cur:
        if cur.execute(
            "SELECT 1 FROM allocation_plan WHERE allocation_plan_id = %s AND owner_user_id = %s",
            (plan_id, owner_user_id),
        ).fetchone() is None:
            raise PlanNotFound(f"plan {plan_id} not found")
        return cur.execute(
            """SELECT v.version_no, v.created_at, v.fleet_size, v.iso_dow,
                      v.start_hour, v.end_hour, v.note,
                      count(DISTINCT r.location_id) FILTER (WHERE r.final_taxis > 0)::int AS zones_used,
                      count(*) FILTER (WHERE r.final_taxis <> r.proposed_taxis)::int     AS edited_rows
               FROM allocation_plan_version v
               LEFT JOIN allocation_result r USING (allocation_plan_id, version_no)
               WHERE v.allocation_plan_id = %s
               GROUP BY v.allocation_plan_id, v.version_no
               ORDER BY v.version_no DESC""",
            (plan_id,),
        ).fetchall()


def get_version(conn: psycopg.Connection, owner_user_id: int, plan_id: int,
                version_no: int) -> dict:
    """A saved version's settings, boroughs and results."""
    with conn.cursor(row_factory=dict_row) as cur:
        version = cur.execute(
            """SELECT p.name, v.*,
                      array(SELECT borough_id FROM allocation_plan_version_borough vb
                            WHERE vb.allocation_plan_id = v.allocation_plan_id
                              AND vb.version_no = v.version_no
                            ORDER BY borough_id) AS borough_ids
               FROM allocation_plan p
               JOIN allocation_plan_version v USING (allocation_plan_id)
               WHERE p.allocation_plan_id = %s AND p.owner_user_id = %s AND v.version_no = %s""",
            (plan_id, owner_user_id, version_no),
        ).fetchone()
        if version is None:
            raise PlanNotFound(f"plan {plan_id} version {version_no} not found")
        version["results"] = cur.execute(
            """SELECT r.hour, r.location_id, z.zone_name, b.name AS borough,
                      r.proposed_taxis, r.final_taxis, r.score, r.rank, r.sample_size, r.reason
               FROM allocation_result r
               JOIN taxi_zone z USING (location_id)
               JOIN borough b USING (borough_id)
               WHERE r.allocation_plan_id = %s AND r.version_no = %s
               ORDER BY r.hour, r.rank""",
            (plan_id, version_no),
        ).fetchall()
    return version


def compare_versions(conn: psycopg.Connection, owner_user_id: int, plan_id: int,
                     from_version: int, to_version: int) -> list[dict]:
    """Zones whose taxis changed between two versions, added and dropped included."""
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            """WITH a AS (SELECT r.* FROM allocation_result r
                          JOIN allocation_plan p USING (allocation_plan_id)
                          WHERE r.allocation_plan_id = %(plan)s AND p.owner_user_id = %(owner)s
                            AND r.version_no = %(v_from)s),
                    b AS (SELECT r.* FROM allocation_result r
                          JOIN allocation_plan p USING (allocation_plan_id)
                          WHERE r.allocation_plan_id = %(plan)s AND p.owner_user_id = %(owner)s
                            AND r.version_no = %(v_to)s),
                    diff AS (
                        SELECT coalesce(a.hour, b.hour)               AS hour,
                               coalesce(a.location_id, b.location_id) AS location_id,
                               coalesce(a.final_taxis, 0)             AS taxis_before,
                               coalesce(b.final_taxis, 0)             AS taxis_after
                        FROM a FULL OUTER JOIN b USING (hour, location_id))
               SELECT d.hour, d.location_id, z.zone_name, bo.name AS borough,
                      d.taxis_before, d.taxis_after,
                      d.taxis_after - d.taxis_before AS change
               FROM diff d
               JOIN taxi_zone z USING (location_id)
               JOIN borough bo USING (borough_id)
               WHERE d.taxis_before <> d.taxis_after
               ORDER BY d.hour, abs(d.taxis_after - d.taxis_before) DESC, d.location_id""",
            {"plan": plan_id, "owner": owner_user_id, "v_from": from_version, "v_to": to_version},
        ).fetchall()


def rename_plan(conn: psycopg.Connection, owner_user_id: int, plan_id: int, name: str) -> None:
    try:
        with conn.transaction():
            updated = conn.execute(
                """UPDATE allocation_plan SET name = %s, updated_at = now()
                   WHERE allocation_plan_id = %s AND owner_user_id = %s""",
                (name.strip(), plan_id, owner_user_id),
            ).rowcount
    except psycopg.errors.UniqueViolation as e:
        raise PlanError(f"you already have a plan called {name.strip()!r}") from e
    except psycopg.errors.CheckViolation as e:
        raise PlanError("plan name can't be empty") from e
    if not updated:
        raise PlanNotFound(f"plan {plan_id} not found")


def delete_plan(conn: psycopg.Connection, owner_user_id: int, plan_id: int) -> None:
    """Deletes the plan with all its versions, boroughs and results (cascade)."""
    with conn.transaction():
        deleted = conn.execute(
            "DELETE FROM allocation_plan WHERE allocation_plan_id = %s AND owner_user_id = %s",
            (plan_id, owner_user_id),
        ).rowcount
    if not deleted:
        raise PlanNotFound(f"plan {plan_id} not found")


# --- PostgreSQL vs MongoDB ---------------------------------------------------

STAT_FIELDS = ("days", "trips", "avg_pickups", "avg_imbalance", "sd_pickups")


def mongo_stats_pipeline(p: PlanParams, boroughs: list[str]) -> list[dict]:
    """STATS_SQL as a MongoDB aggregation on the hourly time-series
    collection: the same filter and the same five numbers per zone and hour."""
    return [
        {"$match": {"meta.borough": {"$in": boroughs},
                    "isoDayOfWeek": p.iso_dow,
                    "localHour": {"$gte": p.start_hour, "$lte": p.end_hour}}},
        {"$group": {"_id": {"zone": "$meta.zoneId", "hour": "$localHour"},
                    "days": {"$sum": 1},
                    "trips": {"$sum": "$pickups"},
                    "avg_pickups": {"$avg": "$pickups"},
                    "avg_imbalance": {"$avg": "$imbalance"},
                    "sd_pickups": {"$stdDevPop": "$pickups"}}},
    ]


def _timed(fn, runs: int):
    times, result = [], None
    for _ in range(runs):
        t0 = time.perf_counter()
        result = fn()
        times.append((time.perf_counter() - t0) * 1000)
    return result, {"first_ms": round(times[0], 2), "median_ms": round(statistics.median(times), 2)}


def compare_stores(conn: psycopg.Connection, mongo_db, p: PlanParams, runs: int = 5) -> dict:
    """The planner's zone-hour statistics from PostgreSQL (STATS_SQL on
    zone_hour_observation) and from MongoDB (the time-series collection),
    compared value by value and timed: the first run, which may be cold, and
    the median of `runs` runs.

    Median fares aren't compared: a median can't be rebuilt from hourly sums,
    so they only exist in PostgreSQL (zone_weekday_hour_fare)."""
    boroughs = [name for (name,) in conn.execute(
        "SELECT name FROM borough WHERE borough_id = ANY(%s) ORDER BY name", (p.borough_ids,))]
    pipeline = mongo_stats_pipeline(p, boroughs)

    def from_postgres():
        with conn.cursor(row_factory=dict_row) as cur:
            return cur.execute(STATS_SQL, _sql_params(p)).fetchall()

    def from_mongo():
        return list(mongo_db["zone_activity_timeseries"].aggregate(pipeline))

    pg_rows, pg_time = _timed(from_postgres, runs)
    mongo_rows, mongo_time = _timed(from_mongo, runs)
    pg = {(r["location_id"], r["hour"]): r for r in pg_rows}
    mongo = {(d["_id"]["zone"], d["_id"]["hour"]): d for d in mongo_rows}

    mismatches = []
    for key in sorted(pg.keys() | mongo.keys()):
        a, b = pg.get(key), mongo.get(key)
        if a is None or b is None:
            fields = [f"missing in {'PostgreSQL' if a is None else 'MongoDB'}"]
        else:
            fields = [f for f in STAT_FIELDS
                      if not math.isclose(float(a[f]), float(b[f]), rel_tol=1e-9, abs_tol=1e-9)]
        if fields:
            mismatches.append({"location_id": key[0], "hour": key[1], "fields": fields})

    return {
        "zone_hours": len(pg),
        "values_compared": len(pg) * len(STAT_FIELDS),
        "fields": STAT_FIELDS,
        "mismatch_count": len(mismatches),
        "mismatches": mismatches[:20],
        "runs": runs,
        "postgres": pg_time,
        "mongodb": mongo_time,
        "postgres_sql": " ".join(STATS_SQL.split()),
        "mongodb_pipeline": pipeline,
    }
