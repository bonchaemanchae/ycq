"""Rebuild one month of summaries in PostgreSQL.

    python build_aggregates.py --month 2026-01

Deletes and re-inserts that month's zone_hour_observation rows in one
transaction (every zone with a map shape x every local hour of the month,
zeros included), then refreshes the od_summary and zone_weekday_hour_fare
materialised views (both cover every loaded month). Running it twice gives the
same result.
"""
import argparse
import time

from common import next_month, parse_month, pg_connect

GRID_SQL = """
WITH hours AS (
    -- Real New York hours in the month. Generated in UTC and converted back,
    -- so the spring-forward hour that doesn't exist is skipped.
    SELECT DISTINCT g AT TIME ZONE 'America/New_York' AS obs_hour
    FROM generate_series(%(start)s::timestamp AT TIME ZONE 'America/New_York',
                         %(end)s::timestamp AT TIME ZONE 'America/New_York' - interval '1 hour',
                         interval '1 hour') AS g
),
zones AS (
    SELECT location_id FROM taxi_zone WHERE geom IS NOT NULL
),
pu AS (
    SELECT t.pickup_location_id AS location_id,
           date_trunc('hour', t.pickup_ts) AS obs_hour,
           count(*) AS pickups,
           sum(t.fare_amount) FILTER (WHERE fare_ok) AS fare_sum,
           count(*) FILTER (WHERE fare_ok) AS fare_trip_count,
           sum(t.trip_distance) FILTER (WHERE dist_ok) AS distance_sum,
           count(*) FILTER (WHERE dist_ok) AS distance_trip_count,
           sum(extract(epoch FROM t.dropoff_ts - t.pickup_ts)) FILTER (WHERE dur_ok) AS duration_sum_s,
           count(*) FILTER (WHERE dur_ok) AS duration_trip_count
    FROM (
        SELECT t.*,
               (t.payment_type_id <> 0 AND t.fare_amount > 0
                    AND NOT coalesce(f.skip_fare, false)) AS fare_ok,
               NOT coalesce(f.skip_distance, false) AS dist_ok,
               NOT coalesce(f.skip_duration, false) AS dur_ok
        FROM trip t
        LEFT JOIN v_trip_flags f USING (import_batch_id, source_row_number, pickup_ts)
        WHERE t.pickup_ts >= %(start)s AND t.pickup_ts < %(end)s
          AND NOT coalesce(f.skip_all, false)
    ) t
    GROUP BY 1, 2
),
dropoffs AS (
    -- Drop-offs in this month, including trips picked up late the month before
    -- (no accepted trip is longer than 24 hours).
    SELECT t.dropoff_location_id AS location_id,
           date_trunc('hour', t.dropoff_ts) AS obs_hour,
           count(*) AS dropoffs
    FROM trip t
    LEFT JOIN v_trip_flags f USING (import_batch_id, source_row_number, pickup_ts)
    WHERE t.pickup_ts >= %(start)s::timestamp - interval '1 day' AND t.pickup_ts < %(end)s
      AND t.dropoff_ts >= %(start)s AND t.dropoff_ts < %(end)s
      AND NOT coalesce(f.skip_all, false)
      AND NOT coalesce(f.skip_dropoff, false)
    GROUP BY 1, 2
)
INSERT INTO zone_hour_observation (
    location_id, obs_hour, obs_hour_utc, local_date, local_hour, iso_dow,
    pickups, dropoffs, fare_sum, fare_trip_count, distance_sum,
    distance_trip_count, duration_sum_s, duration_trip_count)
SELECT z.location_id,
       h.obs_hour,
       h.obs_hour AT TIME ZONE 'America/New_York',
       h.obs_hour::date,
       extract(hour FROM h.obs_hour),
       extract(isodow FROM h.obs_hour),
       coalesce(pu.pickups, 0),
       coalesce(d.dropoffs, 0),
       coalesce(pu.fare_sum, 0),
       coalesce(pu.fare_trip_count, 0),
       coalesce(pu.distance_sum, 0),
       coalesce(pu.distance_trip_count, 0),
       coalesce(pu.duration_sum_s, 0),
       coalesce(pu.duration_trip_count, 0)
FROM zones z
CROSS JOIN hours h
LEFT JOIN pu ON pu.location_id = z.location_id AND pu.obs_hour = h.obs_hour
LEFT JOIN dropoffs d ON d.location_id = z.location_id AND d.obs_hour = h.obs_hour
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True, help="YYYY-MM")
    args = ap.parse_args()
    start = parse_month(args.month)
    end = next_month(start)
    params = {"start": start, "end": end}

    t0 = time.perf_counter()
    with pg_connect(autocommit=True) as conn:
        with conn.transaction():
            deleted = conn.execute(
                "DELETE FROM zone_hour_observation WHERE obs_hour >= %(start)s AND obs_hour < %(end)s",
                params,
            ).rowcount
            inserted = conn.execute(GRID_SQL, params).rowcount
        print(f"zone_hour_observation {args.month}: deleted {deleted:,}, inserted {inserted:,} "
              f"({time.perf_counter() - t0:.1f}s)")

        t0 = time.perf_counter()
        conn.execute("REFRESH MATERIALIZED VIEW od_summary")
        conn.execute("ANALYZE zone_hour_observation")
        conn.execute("ANALYZE od_summary")
        rows = conn.execute(
            "SELECT count(*), sum(trips) FROM od_summary WHERE month = %s", (start,)
        ).fetchone()
        print(f"od_summary {args.month}: {rows[0]:,} rows, {rows[1]:,} trips "
              f"({time.perf_counter() - t0:.1f}s)")

        # Medians don't add up month by month, so this is rebuilt from every
        # loaded month each time.
        t0 = time.perf_counter()
        conn.execute("REFRESH MATERIALIZED VIEW zone_weekday_hour_fare")
        conn.execute("ANALYZE zone_weekday_hour_fare")
        rows = conn.execute(
            "SELECT count(*), sum(fare_trip_count) FROM zone_weekday_hour_fare"
        ).fetchone()
        print(f"zone_weekday_hour_fare (all months): {rows[0]:,} rows, {rows[1]:,} trips "
              f"({time.perf_counter() - t0:.1f}s)")


if __name__ == "__main__":
    main()
