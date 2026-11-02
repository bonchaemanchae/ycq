"""The evaluation scripts: the planner backtest and the load test.

The backtest must judge a plan on data the plan never saw, so the main test
here is that the training tables really stop at the cut-off. The load test
needs a running API, so only its command line is checked.
"""
import sys
from datetime import date

import pytest

from conftest import ROOT, pg_connect, run_ok

sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT))
import backtest_planner as bt  # noqa: E402
from api import planner  # noqa: E402
from api.db import pg_pool  # noqa: E402

MARCH = date(2026, 3, 1)


@pytest.mark.parametrize("weights, fleet, expected", [
    ({1: 0.9, 2: 0.6, 3: 0.3}, 10, {1: 5, 2: 3, 3: 2}),     # the largest remainder gets the spare taxi
    ({1: 1.0, 2: 1.0, 3: 1.0}, 10, {1: 4, 2: 3, 3: 3}),     # a tie goes to the lower zone id
    ({1: 0.0, 2: 0.0}, 5, {1: 3, 2: 2}),                    # no information: an even split
    ({1: 5.0}, 7, {1: 7}),
])
def test_fair_split_always_adds_up_to_the_fleet(weights, fleet, expected):
    taxis = bt.fair_split(weights, fleet)
    assert taxis == expected and sum(taxis.values()) == fleet


def test_measure_scores_a_plan_on_what_happened():
    actual = {"pickups": {1: 60, 2: 30, 3: 10}, "net": {1: 20, 2: -5, 3: 5},
              "dates": {"d1": {1: 40, 2: 20, 3: 5}, "d2": {1: 20, 2: 10, 3: 5}}}
    result = bt.measure({1: 30, 3: 10}, actual)
    assert result["Coverage"] == (70, 100)               # zones 1 and 3 had 70 of 100 pickups
    assert result["Shortages"] == (25, 25)               # both zones short of taxis got some
    assert result["Fit"] == pytest.approx((60 + 0 + 10, 100))   # taxi shares 75/25 vs pickups 60/30/10
    # Taxis with a pickup: day 1 min(30,40) + min(10,5), day 2 min(30,20) + min(10,5), of 40 x 2
    assert result["Taxis in use"] == (60, 80)


def test_training_tables_stop_before_the_test_month(mongo):
    with pg_connect(autocommit=True) as conn:
        bt.use_training_months(conn, MARCH)
        (months,) = conn.execute(
            "SELECT array_agg(DISTINCT date_trunc('month', obs_hour)::date) FROM zone_hour_observation").fetchone()
        assert MARCH not in months and len(months) == 2
        # March's two trips start in zone 1 on a Sunday night; the planner mustn't count them.
        (real,) = conn.execute(
            """SELECT sum(pickups) FROM public.zone_hour_observation
               WHERE location_id = 1 AND iso_dow = 7""").fetchone()
        (seen,) = conn.execute(
            "SELECT coalesce(sum(pickups), 0) FROM zone_hour_observation WHERE location_id = 1 AND iso_dow = 7"
        ).fetchone()
        assert seen < real
        manhattan = conn.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'").fetchone()[0]
        params = planner.PlanParams(fleet_size=5, iso_dow=1, start_hour=8, end_hour=8,
                                    borough_ids=[manhattan], min_sample=0)
        assert planner.score(conn, params)                  # the real planner runs on the temporary tables
    with pg_connect(autocommit=True) as conn:               # and they vanished with their connection
        assert conn.execute("SELECT count(*) FROM zone_hour_observation WHERE obs_hour >= %s",
                            (MARCH,)).fetchone()[0] > 0


def test_backtest_runs_and_changes_nothing(db):
    before = db.execute("SELECT count(*) FROM allocation_plan").fetchone()
    out = run_ok("etl/backtest_planner.py", "--fleets", "5").stdout
    assert "All boroughs, fleet 5" in out and "Manhattan, fleet 5" in out
    assert db.execute("SELECT count(*) FROM allocation_plan").fetchone() == before


def test_the_pool_has_a_connection_for_every_worker_thread():
    """With fewer, the load test stalled at 50 simultaneous requests: every
    thread waiting for a connection, and no thread free to finish a request."""
    assert pg_pool.max_size >= 40


def test_load_test_command_line():
    assert "--users" in run_ok("etl/load_test.py", "--help").stdout
