"""Allocation planner: scoring, the fleet split and saving versions.

Uses the sample months from conftest (zones 1-3, all in Manhattan). Each test
runs in a transaction that is rolled back, so nothing is kept.
"""
import sys

import pytest

from conftest import ROOT, pg_connect

sys.path.insert(0, str(ROOT))
from api import planner  # noqa: E402
from api.planner import PlanError, PlanNotFound, PlanParams  # noqa: E402


@pytest.fixture
def conn(loaded):
    c = pg_connect()
    yield c
    c.rollback()
    c.close()


@pytest.fixture
def setup(conn):
    """Two users, a plan owned by the first, and Manhattan's borough id."""
    owner, other = (
        conn.execute(
            """INSERT INTO app_user (email, display_name, password_hash)
               VALUES (%s, %s, 'x') RETURNING user_id""",
            (email, email),
        ).fetchone()[0]
        for email in ("anna@test", "other@test")
    )
    manhattan = conn.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'").fetchone()[0]
    plan_id = planner.create_plan(conn, owner, "Monday morning")
    return owner, other, plan_id, manhattan


def params(manhattan, **kw):
    # Mondays 8-9 AM: zone 1 has the January sample trips at 8 AM.
    base = dict(fleet_size=7, iso_dow=1, start_hour=8, end_hour=9,
                borough_ids=[manhattan], max_zones_per_hour=2, min_sample=0)
    return PlanParams(**{**base, **kw})


def hour_totals(rows, key="proposed_taxis"):
    totals = {}
    for r in rows:
        totals[r["hour"]] = totals.get(r["hour"], 0) + r[key]
    return totals


def test_preview_splits_the_whole_fleet_every_hour(conn, setup):
    _, _, _, manhattan = setup
    rows = planner.preview(conn, params(manhattan))
    assert hour_totals(rows) == {8: 7, 9: 7}
    assert all(r["rank"] <= 2 and 0 < r["score"] <= 1 for r in rows)
    # Zone 1 is the only zone with pickups on Monday at 8, so it ranks first.
    assert rows[0]["hour"] == 8 and rows[0]["location_id"] == 1


def test_save_creates_numbered_versions(conn, setup):
    owner, _, plan_id, manhattan = setup
    assert planner.save_version(conn, owner, plan_id, params(manhattan)) == 1
    assert planner.save_version(conn, owner, plan_id, params(manhattan, fleet_size=4)) == 2
    v2 = planner.get_version(conn, owner, plan_id, 2)
    assert v2["fleet_size"] == 4 and v2["borough_ids"] == [manhattan]
    assert hour_totals(v2["results"], "final_taxis") == {8: 4, 9: 4}
    summary = planner.list_plans(conn, owner)[0]
    assert (summary["latest_version"], summary["total_taxis"]) == (2, 8)


def test_analyst_edits_are_saved_and_compared(conn, setup):
    owner, _, plan_id, manhattan = setup
    p = params(manhattan)
    planner.save_version(conn, owner, plan_id, p)
    first, second = planner.preview(conn, p)[:2]          # hour 8
    edits = {(8, first["location_id"]): first["proposed_taxis"] - 1,
             (8, second["location_id"]): second["proposed_taxis"] + 1}
    planner.save_version(conn, owner, plan_id, p, edits)
    changes = planner.compare_versions(conn, owner, plan_id, 1, 2)
    assert sorted(c["change"] for c in changes) == [-1, 1]
    assert all(c["zone_name"] and c["borough"] == "Manhattan" for c in changes)


def test_adding_a_zone_outside_the_proposal(conn, setup):
    owner, _, plan_id, manhattan = setup
    p = params(manhattan, max_zones_per_hour=1)            # only one zone proposed
    top, extra = [r for r in planner.score(conn, p) if r["hour"] == 8][:2]
    planner.save_version(conn, owner, plan_id, p,
                         {(8, top["location_id"]): 5, (8, extra["location_id"]): 2})
    results = planner.get_version(conn, owner, plan_id, 1)["results"]
    added = next(r for r in results if r["location_id"] == extra["location_id"] and r["hour"] == 8)
    assert (added["proposed_taxis"], added["final_taxis"]) == (0, 2)
    assert added["reason"].startswith("added by analyst")


def test_edit_that_breaks_the_fleet_total_is_refused(conn, setup):
    owner, _, plan_id, manhattan = setup
    p = params(manhattan)
    top = planner.preview(conn, p)[0]
    with pytest.raises(PlanError, match="add up to"):
        planner.save_version(conn, owner, plan_id, p, {(8, top["location_id"]): 99})
    assert planner.list_plans(conn, owner)[0]["latest_version"] is None   # nothing kept


def test_hour_with_no_eligible_zone_is_refused(conn, setup):
    owner, _, plan_id, manhattan = setup
    with pytest.raises(PlanError, match=r"hour\(s\) 9"):
        # Monday pickups in zone 1: five at 8 AM, one at 9 AM (2 February).
        planner.save_version(conn, owner, plan_id, params(manhattan, min_sample=2))


def test_unknown_zone_in_edits_is_refused(conn, setup):
    owner, _, plan_id, manhattan = setup
    with pytest.raises(PlanError, match="not eligible"):
        planner.save_version(conn, owner, plan_id, params(manhattan), {(8, 264): 1})


def test_other_users_cannot_see_or_change_the_plan(conn, setup):
    owner, other, plan_id, manhattan = setup
    planner.save_version(conn, owner, plan_id, params(manhattan))
    with pytest.raises(PlanNotFound):
        planner.save_version(conn, other, plan_id, params(manhattan))
    with pytest.raises(PlanNotFound):
        planner.get_version(conn, other, plan_id, 1)
    with pytest.raises(PlanNotFound):
        planner.delete_plan(conn, other, plan_id)
    assert planner.compare_versions(conn, other, plan_id, 1, 1) == []
    assert planner.list_plans(conn, other) == []


def test_rename_and_delete(conn, setup):
    owner, _, plan_id, manhattan = setup
    planner.create_plan(conn, owner, "Taken")
    with pytest.raises(PlanError, match="already have"):
        planner.rename_plan(conn, owner, plan_id, "Taken")
    planner.rename_plan(conn, owner, plan_id, "Monday AM")
    planner.save_version(conn, owner, plan_id, params(manhattan))
    planner.delete_plan(conn, owner, plan_id)
    assert conn.execute(
        "SELECT count(*) FROM allocation_result WHERE allocation_plan_id = %s", (plan_id,)
    ).fetchone()[0] == 0


def test_score_is_the_weighted_sum_of_its_percentiles(conn, setup):
    _, _, _, manhattan = setup
    p = params(manhattan)
    for r in planner.score(conn, p):
        parts = (p.w_pickup * r["pct_pickup"] + p.w_imbalance * r["pct_imbalance"]
                 + p.w_consistency * r["pct_consistency"] + p.w_fare * r["pct_fare"])
        # the percentiles are rounded to 3 places, the score to 5
        assert abs(r["score"] - parts) < 0.001
        assert all(0 < r[k] <= 1 for k in ("pct_pickup", "pct_imbalance",
                                          "pct_consistency", "pct_fare"))


def test_versions_are_listed_newest_first(conn, setup):
    owner, other, plan_id, manhattan = setup
    assert planner.list_versions(conn, owner, plan_id) == []
    planner.save_version(conn, owner, plan_id, params(manhattan, note="first try"))
    top = planner.preview(conn, params(manhattan, fleet_size=4))[:2]
    planner.save_version(conn, owner, plan_id, params(manhattan, fleet_size=4),
                         {(8, top[0]["location_id"]): top[0]["proposed_taxis"] - 1,
                          (8, top[1]["location_id"]): top[1]["proposed_taxis"] + 1})
    v2, v1 = planner.list_versions(conn, owner, plan_id)
    assert (v2["version_no"], v2["fleet_size"], v2["edited_rows"]) == (2, 4, 2)
    assert (v1["version_no"], v1["note"], v1["edited_rows"]) == (1, "first try", 0)
    with pytest.raises(PlanNotFound):
        planner.list_versions(conn, other, plan_id)


def test_zone_without_a_median_fare_counts_as_lowest_fare(conn, setup):
    # With min_sample=0, zones 2 and 3 are eligible at 8 AM on Mondays but have
    # no metered trips then, so zone_weekday_hour_fare has no median for them.
    _, _, _, manhattan = setup
    rows = [r for r in planner.score(conn, params(manhattan, max_zones_per_hour=3)) if r["hour"] == 8]
    no_median = [r for r in rows if r["median_fare"] is None]
    with_median = [r for r in rows if r["median_fare"] is not None]
    assert no_median and with_median
    assert max(r["pct_fare"] for r in no_median) < min(r["pct_fare"] for r in with_median)
    assert all("median fare unknown" in r["reason"] for r in no_median)


def test_postgres_and_mongodb_give_the_same_statistics(conn, setup, mongo):
    _, _, _, manhattan = setup
    result = planner.compare_stores(conn, mongo, params(manhattan, start_hour=0, end_hour=23), runs=2)
    # 3 Manhattan test zones x 24 hours, every value equal in both databases
    assert result["zone_hours"] == 72
    assert result["mismatch_count"] == 0, result["mismatches"]
    assert result["postgres"]["median_ms"] > 0 and result["mongodb"]["median_ms"] > 0


def test_same_inputs_give_the_same_plan(conn, setup):
    _, _, _, manhattan = setup
    p = params(manhattan, min_sample=0, max_zones_per_hour=3)
    assert planner.score(conn, p) == planner.score(conn, p)


def test_zone_with_no_pickups_has_no_consistency(conn, setup):
    # Zones 2 and 3 have no pickups on Mondays at 8 AM in the sample data.
    _, _, _, manhattan = setup
    rows = {r["location_id"]: r for r in planner.score(conn, params(manhattan, max_zones_per_hour=3))
            if r["hour"] == 8}
    assert rows[1]["avg_pickups"] > 0 and rows[2]["avg_pickups"] == rows[3]["avg_pickups"] == 0
    assert rows[1]["pct_consistency"] > rows[2]["pct_consistency"]
