"""MongoDB loading, validators and reconciliation."""
import sys
from datetime import datetime, timezone

import pytest
from pymongo.errors import DuplicateKeyError, WriteError

from conftest import ROOT, run, run_ok

sys.path.insert(0, str(ROOT / "etl"))
import load_mongo  # noqa: E402

MONTHS = ("2026-01", "2026-02", "2026-03")


def jan(coll):
    return coll.count_documents({"localDate": {"$gte": "2026-01-01", "$lt": "2026-02-01"}})


def test_all_months_reconcile(mongo):
    for month in MONTHS:
        result = run_ok("etl/reconcile.py", "--month", month)
        assert "PASSED" in result.stdout


def test_reload_twice_gives_same_documents(mongo):
    hourly, daily = mongo["zone_activity_timeseries"], mongo["zone_activity_daily"]
    boroughs = mongo["borough_activity_hourly"]
    before = jan(hourly), jan(daily), jan(boroughs)
    run_ok("etl/load_mongo.py", "--month", "2026-01")
    run_ok("etl/load_mongo.py", "--month", "2026-01")
    assert (jan(hourly), jan(daily), jan(boroughs)) == before == (3 * 744, 3 * 31, 744)   # 3 Manhattan zones


def test_tampered_document_is_detected(mongo):
    hourly = mongo["zone_activity_timeseries"]
    hourly.delete_one({"localDate": "2026-01-05", "localHour": 8, "meta.zoneId": 1})
    result = run("etl/reconcile.py", "--month", "2026-01")
    assert result.returncode == 1
    assert "FAILED" in result.stdout
    # Rebuilding the month from PostgreSQL fixes it.
    run_ok("etl/load_mongo.py", "--month", "2026-01")
    assert "PASSED" in run_ok("etl/reconcile.py", "--month", "2026-01").stdout


HOUR_DOC = {"localDate": "2026-01-05", "localHour": 8, "meta.zoneId": 1}


def edit_hourly(coll, field, value):
    # MongoDB only allows updates on a time-series collection that filter on
    # the meta field, so a hand edit is simulated as delete + insert.
    doc = coll.find_one(HOUR_DOC)
    coll.delete_many(HOUR_DOC)
    coll.insert_one({**doc, field: value})


def edit_summary(coll, field, value):
    # Ordinary collections, so a plain update works.
    assert coll.update_one({"localDate": "2026-01-05"}, {"$set": {field: value}}).modified_count == 1


def edit_destination(coll, field, value):
    query = {"month": "2026-01", "originZoneId": 1, "destinations.0": {"$exists": True}}
    assert coll.update_one(query, {"$set": {f"destinations.0.{field}": value}}).modified_count == 1


@pytest.mark.parametrize("collection, edit, field, value", [
    # values the dashboard and flow explorer show, not just counts
    ("zone_activity_timeseries", edit_hourly, "distanceSum", 999.0),
    ("zone_activity_timeseries", edit_hourly, "fareSum", 12345.0),
    ("zone_activity_daily", edit_summary, "pickups", 999),
    ("borough_activity_hourly", edit_summary, "durationSumSec", 999.0),
    ("origin_destination_snapshots", edit_destination, "averageDurationSec", 1.0),
    ("origin_destination_snapshots", edit_destination, "share", 0.5),
])
def test_tampered_value_is_detected(mongo, collection, edit, field, value):
    edit(mongo[collection], field, value)
    result = run("etl/reconcile.py", "--month", "2026-01")
    assert result.returncode == 1
    assert "FAILED" in result.stdout
    run_ok("etl/load_mongo.py", "--month", "2026-01")
    assert "PASSED" in run_ok("etl/reconcile.py", "--month", "2026-01").stdout


ACTIVITY = ("zone_activity_timeseries", "zone_activity_daily", "borough_activity_hourly")


def test_activity_fields_have_one_type_in_every_document(mongo):
    """A field that is null in one document and a number in the next closes a
    time-series bucket, so activity documents hold sums and counts only."""
    fields = list(load_mongo.hourly_fields(0, 0, 0, 0, 0, 0, 0, 0))
    assert not [f for f in fields if f.startswith("average")]
    for name in ACTIVITY:
        assert mongo[name].count_documents({}) > 0
        assert mongo[name].count_documents({"$or": [{f: None} for f in fields]}) == 0, name
        assert mongo[name].count_documents({"averageFare": {"$exists": True}}) == 0, name


def test_collections_with_stored_averages_are_rebuilt(mongo):
    """A database loaded before the averages were left out: the collections
    are dropped, load_all.py sees their months missing and loads them again,
    and no time-series bucket is closed by a change of type."""
    old = dict(mongo["zone_activity_daily"].find_one({}, {"_id": 0}), averageFare=None)
    for name in ACTIVITY:
        mongo[name].delete_many({})
    mongo["zone_activity_timeseries"].insert_one({**old, "timestamp": datetime(2026, 1, 5, 13, tzinfo=timezone.utc),
                                                  "localHour": 8})
    mongo["zone_activity_daily"].insert_one(old)
    try:
        assert load_mongo.drop_old_layouts(mongo) == ["zone_activity_timeseries", "zone_activity_daily"]
        assert load_mongo.drop_old_layouts(mongo) == []
    finally:
        load_mongo.ensure_collections(mongo)
        for month in ("2026-01", "2026-02", "2026-03"):
            run_ok("etl/load_mongo.py", "--month", month)
            assert "PASSED" in run_ok("etl/reconcile.py", "--month", month).stdout
    stats = mongo.command("collStats", "zone_activity_timeseries")["timeseries"]
    assert stats["bucketCount"] > 0 and stats.get("numBucketsClosedDueToSchemaChange", 0) == 0


def test_summary_validators_and_unique_keys(mongo):
    daily = mongo["zone_activity_daily"]
    doc = daily.find_one({"localDate": "2026-01-05"}, {"_id": 0})
    with pytest.raises(DuplicateKeyError):          # one document per zone and day
        daily.insert_one(dict(doc))
    with pytest.raises(WriteError):
        daily.insert_one({**doc, "localDate": "5 January"})
    with pytest.raises(WriteError):
        mongo["borough_activity_hourly"].insert_one({"localDate": "2026-01-05", "pickups": -1})


def test_reconciliation_reports_orphaned_views_without_failing(mongo, db):
    views = mongo["saved_analysis_views"]
    views.insert_one(saved_view(ownerUserId=987654, name="Lost"))
    try:
        result = run_ok("etl/reconcile.py", "--month", "2026-01")
        assert "PASSED" in result.stdout and "owners [987654] no longer exist" in result.stdout
        (details,) = db.execute("SELECT details FROM reconciliation_run ORDER BY reconciliation_run_id DESC "
                                "LIMIT 1").fetchone()
        assert 987654 in details["orphaned_views"]["owners"]
    finally:
        views.delete_many({"ownerUserId": 987654})


def saved_view(**overrides):
    now = datetime.now(timezone.utc)
    view = {"ownerUserId": 1, "name": "Morning peak", "page": "flows",
            "filters": {"dateFrom": "2026-01-01", "dateTo": "2026-01-31",
                        "hourFrom": 6, "hourTo": 10, "zoneIds": [1, 2]},
            "createdAt": now, "updatedAt": now}
    view.update(overrides)
    return view


def test_saved_view_validator(mongo):
    views = mongo["saved_analysis_views"]
    views.insert_one(saved_view())
    with pytest.raises(WriteError):
        views.insert_one(saved_view(name="Extra field", colour="red"))
    with pytest.raises(WriteError):
        views.insert_one(saved_view(name="Bad date", filters={"dateFrom": "January"}))
    with pytest.raises(WriteError):
        views.insert_one(saved_view(name="Bad page", page="settings"))
    with pytest.raises(Exception):   # duplicate name for the same owner
        views.insert_one(saved_view())
    views.delete_many({"ownerUserId": 1})
