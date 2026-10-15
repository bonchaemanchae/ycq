"""MongoDB loading, validators and reconciliation."""
from datetime import datetime, timezone

import pytest
from pymongo.errors import WriteError

from conftest import run, run_ok

MONTHS = ("2026-01", "2026-02", "2026-03")


def jan(coll):
    return coll.count_documents({"localDate": {"$gte": "2026-01-01", "$lt": "2026-02-01"}})


def test_all_months_reconcile(mongo):
    for month in MONTHS:
        result = run_ok("etl/reconcile.py", "--month", month)
        assert "PASSED" in result.stdout


def test_reload_twice_gives_same_documents(mongo):
    hourly = mongo["zone_activity_timeseries"]
    before = jan(hourly)
    run_ok("etl/load_mongo.py", "--month", "2026-01")
    run_ok("etl/load_mongo.py", "--month", "2026-01")
    assert jan(hourly) == before == 3 * 744


def test_tampered_document_is_detected(mongo):
    hourly = mongo["zone_activity_timeseries"]
    hourly.delete_one({"localDate": "2026-01-05", "localHour": 8, "meta.zoneId": 1})
    result = run("etl/reconcile.py", "--month", "2026-01")
    assert result.returncode == 1
    assert "FAILED" in result.stdout
    # Rebuilding the month from PostgreSQL fixes it.
    run_ok("etl/load_mongo.py", "--month", "2026-01")
    assert "PASSED" in run_ok("etl/reconcile.py", "--month", "2026-01").stdout


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
