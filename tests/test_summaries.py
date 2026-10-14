"""Hourly grid, daylight saving, month-end drop-offs, rebuilds and median fares."""
from conftest import run_ok

ZONES_WITH_SHAPE = 3


def grid(db, month):
    return db.execute(
        """SELECT count(*), sum(pickups), sum(dropoffs), sum(fare_trip_count),
                  sum(distance_trip_count), sum(duration_trip_count)
           FROM zone_hour_observation
           WHERE obs_hour >= %s::date AND obs_hour < %s::date + interval '1 month'""",
        (month, month),
    ).fetchone()


def test_january_grid(db):
    rows, pickups, dropoffs, fare_n, dist_n, dur_n = grid(db, "2026-01-01")
    assert rows == ZONES_WITH_SHAPE * 744
    assert pickups == 17    # 18 accepted, minus the voided trip (W7)
    assert dropoffs == 14   # minus W7, the two W6 trips and the 1 February drop-off
    assert fare_n == 12     # minus Flex Fare, W2 (3 trips), W4 and W7
    assert dist_n == 14     # minus W1, W3, W8 and W7
    assert dur_n == 14      # minus W5, W8, W9 and W7


def test_month_end_dropoff_counts_in_next_month(db):
    assert db.execute(
        """SELECT dropoffs FROM zone_hour_observation
           WHERE location_id = 3 AND obs_hour = '2026-02-01 00:00'"""
    ).fetchone()[0] == 1
    assert grid(db, "2026-02-01")[0] == ZONES_WITH_SHAPE * 672


def test_march_skips_the_missing_daylight_saving_hour(db):
    assert grid(db, "2026-03-01")[0] == ZONES_WITH_SHAPE * 743
    assert db.execute(
        "SELECT count(*) FROM zone_hour_observation WHERE obs_hour = '2026-03-08 02:00'"
    ).fetchone()[0] == 0
    assert db.execute(
        """SELECT count(*) FROM zone_hour_observation
           WHERE location_id = 1 AND local_date = '2026-03-08'"""
    ).fetchone()[0] == 23


def test_rebuild_twice_gives_same_result(db):
    before = grid(db, "2026-01-01")
    od_before = db.execute("SELECT count(*), sum(trips) FROM od_summary").fetchone()
    run_ok("etl/build_aggregates.py", "--month", "2026-01")
    run_ok("etl/build_aggregates.py", "--month", "2026-01")
    assert grid(db, "2026-01-01") == before
    assert db.execute("SELECT count(*), sum(trips) FROM od_summary").fetchone() == od_before


def test_median_fare_uses_metered_trips_only(db):
    # Zone 1, Mondays at 8 AM: fares 15, 10 and 31 count. The Flex Fare trip
    # (row 11) and the $600 W4 trip (row 15) in the same slot don't.
    median, n = db.execute(
        """SELECT median_fare, fare_trip_count FROM zone_weekday_hour_fare
           WHERE location_id = 1 AND iso_dow = 1 AND local_hour = 8"""
    ).fetchone()
    assert (float(median), n) == (15.0, 3)
