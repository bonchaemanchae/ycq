"""Unknown codes (R8), impossible values (R9), and deleting a month so it can
be imported again.

Uses a separate April file, and deletes April again at the end, so the other
tests still see exactly the three sample months.
"""
import pytest

import sample_data
from conftest import run, run_ok
from sample_data import trip

APRIL = [
    trip("2026-04-06 08:00", 15),                 # 1 accepted
    trip("2026-04-06 08:00", 15, vendor=3),       # 2 R8 unknown vendor
    trip("2026-04-06 09:00", 15, payment=9),      # 3 R8 unknown payment type
    trip("2026-04-06 10:00", 15, rate=42),        # 4 R8 unknown rate code
    trip("2026-04-06 11:00", 15, rate=99),        # 5 accepted, rate code 99 -> NULL
    trip("2026-04-06 12:00", 15, pu=264, vendor=3),  # 6 R4 comes before R8
    {**trip("2026-04-06 13:00", 15), "passenger_count": -1},       # 7 R9 negative passengers
    trip("2026-04-06 14:00", 15, dist=123_456_789.0),               # 8 R9 distance too large
    trip("2026-04-06 15:00", 15, fare=float("nan")),                 # 9 R9 fare not a number
    {**trip("2026-04-06 16:00", 15), "tip_amount": float("inf")},  # 10 R9 infinite tip
]
APRIL_REJECTS = {2: "R8", 3: "R8", 4: "R8", 6: "R4", 7: "R9", 8: "R9", 9: "R9", 10: "R9"}


@pytest.fixture
def april(tmp_path, db, mongo):
    path = sample_data.write(APRIL, tmp_path / "apr.parquet")
    yield path
    run("etl/delete_month.py", "--month", "2026-04")


def other_months(db, mongo):
    """Everything about January to March that deleting April must not touch."""
    return (
        db.execute("SELECT count(*) FROM import_batch").fetchone()[0],
        db.execute("SELECT count(*), sum(pickups), sum(dropoffs) FROM zone_hour_observation").fetchone(),
        db.execute("SELECT count(*), sum(trips) FROM od_summary").fetchone(),
        db.execute("SELECT count(*) FROM rejected_trip").fetchone()[0],
        mongo["zone_activity_timeseries"].count_documents({}),
        mongo["zone_activity_daily"].count_documents({}),
        mongo["borough_activity_hourly"].count_documents({}),
        mongo["origin_destination_snapshots"].count_documents({}),
    )


def april_left(db, mongo):
    return {
        "batch": db.execute("SELECT count(*) FROM import_batch WHERE file_month = '2026-04-01'").fetchone()[0],
        "partition": db.execute("SELECT to_regclass('trip_2026_04') IS NOT NULL").fetchone()[0],
        "hours": db.execute(
            "SELECT count(*) FROM zone_hour_observation WHERE local_date >= '2026-04-01'").fetchone()[0],
        "od": db.execute("SELECT count(*) FROM od_summary WHERE month = '2026-04-01'").fetchone()[0],
        "mongo_hourly": mongo["zone_activity_timeseries"].count_documents({"localDate": {"$gte": "2026-04-01"}}),
        "mongo_daily": mongo["zone_activity_daily"].count_documents({"localDate": {"$gte": "2026-04-01"}}),
        "mongo_borough_hourly": mongo["borough_activity_hourly"].count_documents(
            {"localDate": {"$gte": "2026-04-01"}}),
        "mongo_od": mongo["origin_destination_snapshots"].count_documents({"month": "2026-04"}),
    }


def test_bad_codes_and_values_reject_the_row_not_the_month(april, db):
    run_ok("etl/import_month.py", "--month", "2026-04", "--file", str(april))
    batch, accepted, rejected = db.execute(
        """SELECT import_batch_id, rows_accepted, rows_rejected
           FROM import_batch WHERE file_month = '2026-04-01'"""
    ).fetchone()
    assert (accepted, rejected) == (2, 8)
    got = dict(db.execute(
        "SELECT source_row_number, reason_code FROM rejected_trip WHERE import_batch_id = %s", (batch,)
    ).fetchall())
    assert got == APRIL_REJECTS


def test_delete_month_removes_it_and_keeps_the_rest(april, db, mongo):
    before = other_months(db, mongo)
    run_ok("etl/import_month.py", "--month", "2026-04", "--file", str(april))
    run_ok("etl/build_aggregates.py", "--month", "2026-04")
    run_ok("etl/load_mongo.py", "--month", "2026-04")
    loaded = april_left(db, mongo)
    assert all(loaded.values()), loaded

    run_ok("etl/delete_month.py", "--month", "2026-04")
    assert not any(april_left(db, mongo).values())
    assert other_months(db, mongo) == before

    # Harmless to run again, and the month can now be imported again (no R5).
    run_ok("etl/delete_month.py", "--month", "2026-04")
    run_ok("etl/import_month.py", "--month", "2026-04", "--file", str(april))
