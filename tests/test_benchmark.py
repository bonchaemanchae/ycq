"""Benchmark: the timing maths, the answer check, the PostgreSQL store, and a
full run against all three stores (needs MongoDB).

Uses the sample months from conftest, which only have zones 1 to 3, so the
full run uses --zone 1, and for Q5 the slice that zone has trips in: March,
weekend, night (two trips from zone 1 to zone 2 on Sunday 8 March).
"""
import sys
from datetime import datetime, timezone

import pytest

from conftest import ROOT, TEST_DB, pg_connect, run_ok

sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT))
import benchmark  # noqa: E402
from api.routers import admin  # noqa: E402


def test_percentile_is_nearest_rank():
    values = list(range(1, 101))          # 1..100
    assert benchmark.percentile(values, 95) == 95
    assert benchmark.percentile(values, 50) == 50
    assert benchmark.percentile([7.0], 95) == 7.0
    assert benchmark.percentile([3, 1, 2], 100) == 3


def test_answers_must_match_exactly_except_tiny_money_differences():
    pg = [(1, 10, 9, 123.45, 4)]
    assert benchmark.same_answer(pg, [(1, 10, 9, 123.45000000001, 4)])
    assert not benchmark.same_answer(pg, [(1, 11, 9, 123.45, 4)])      # a different count
    assert not benchmark.same_answer(pg, [(1, 10, 9, 123.46, 4)])      # a different cent
    assert not benchmark.same_answer(pg, [])                           # a missing row


def test_utc_conversion_handles_daylight_saving():
    assert benchmark.utc(datetime(2026, 1, 9, 18)) == datetime(2026, 1, 9, 23, tzinfo=timezone.utc)
    assert benchmark.utc(datetime(2026, 3, 9, 18)) == datetime(2026, 3, 9, 22, tzinfo=timezone.utc)


@pytest.fixture
def pg_store(loaded, monkeypatch):
    monkeypatch.setenv("POSTGRES_DB", TEST_DB)
    conn = pg_connect(autocommit=True)
    yield conn
    conn.execute(f"DROP TABLE IF EXISTS {benchmark.PG_TABLE}")
    conn.close()


def test_postgres_store_is_a_full_copy(pg_store):
    load_ms, rows = benchmark.build_postgres(pg_store)
    assert load_ms > 0
    assert rows == pg_store.execute("SELECT count(*) FROM zone_hour_observation").fetchone()[0]
    copied = pg_store.execute(
        f"SELECT count(*), sum(pickups), sum(dropoffs) FROM {benchmark.PG_TABLE}").fetchone()
    original = pg_store.execute(
        "SELECT count(*), sum(pickups), sum(dropoffs) FROM zone_hour_observation").fetchone()
    assert copied == original
    data, index = benchmark.pg_sizes(pg_store, benchmark.PG_TABLE)
    assert data > 0 and index > 0


def test_postgres_queries_return_the_expected_shapes(pg_store):
    benchmark.build_postgres(pg_store)
    answers = {name: benchmark.normalise(name, benchmark.run_pg(pg_store, sql, params), "postgres")
               for name, (sql, params) in benchmark.pg_queries(1).items()}
    q1, q2, q3, q4 = answers.values()
    assert len(q1) == 1 and q1[0][0] == 1
    assert len(q2) == 7 * 24
    assert [row[0] for row in q3] == [1, 2, 3]
    assert len(q4) == 3 and q4 == sorted(q4, key=lambda r: (-r[1], r[0]))


def test_flow_query_in_postgres(pg_store):
    (sql, params), _ = benchmark.flow_queries(1, "weekend", "night")
    rows = benchmark.run_pg(pg_store, sql, params)
    assert benchmark.normalise(benchmark.FLOW_QUERY, rows, "postgres") == [(2, 2)]


def test_full_run_saves_matching_results_for_all_stores(mongo, db):
    run_ok("etl/benchmark.py", "--runs", "3", "--zone", "1",
           "--day-type", "weekend", "--time-bucket", "night")
    results = admin.latest_benchmark(db)["results"]
    hourly = [r for r in results if r["data"] == "hourly"]
    flow = [r for r in results if r["data"] == "destinations"]
    assert len(hourly) == 12                         # 3 stores x 4 questions
    assert {r["store"] for r in hourly} == set(benchmark.HOURLY_STORES)
    assert {r["store"] for r in flow} == {"postgres", "mongo_collection"}
    assert {r["query_name"] for r in flow} == {benchmark.FLOW_QUERY}
    assert all(r["runs"] == 3 and r["median_ms"] > 0 and r["plan_output"] for r in results)
    assert all(r["storage_bytes"] and r["load_ms"] for r in hourly)
    assert all(r["load_ms"] is None for r in flow)   # the app's own stores, not rebuilt


def test_explain_summary_changes_nothing(db, monkeypatch):
    before = db.execute("SELECT count(*), sum(pickups) FROM zone_hour_observation").fetchone()
    out = run_ok("etl/benchmark.py", "--explain-summary", "2026-01").stdout
    assert "Execution Time" in out and "rolled back" in out
    assert db.execute("SELECT count(*), sum(pickups) FROM zone_hour_observation").fetchone() == before
