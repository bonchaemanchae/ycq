"""etl/results.py: reading the latest benchmark and load test runs, how each
store read the data, and printing our saved results.

Uses the test databases from conftest; rows written here are rolled back.
"""
import json
import sys

import pytest

from conftest import ROOT, pg_connect

sys.path.insert(0, str(ROOT / "etl"))
import results  # noqa: E402


@pytest.fixture
def conn(loaded):
    c = pg_connect()
    yield c
    c.rollback()
    c.close()


def test_latest_load_test_is_one_run(conn):
    with conn.transaction(force_rollback=True):
        # dates after any run another test saved, so these two are the newest
        for at, users in (("2030-01-01", 1), ("2030-01-02", 1), ("2030-01-02", 5)):
            conn.execute("""INSERT INTO load_test_run (run_at, question, users, seconds, requests, failed,
                                                       requests_per_sec, median_ms, p95_ms)
                            VALUES (%s, 'Flow Explorer', %s, 5, 100, 0, 20, 4, 6)""", (at, users))
        latest = results.latest_load_test(conn)
        assert latest["run_at"].startswith("2030-01-02")
        assert [r["users"] for r in latest["results"]] == [1, 5]
        json.dumps(latest)   # ready to save as it is


PG_PLAN = """Limit  (cost=1.0..2.0 rows=10 width=10) (actual time=15.6..16.9 rows=10 loops=1)
  Buffers: shared hit=2895 read=5
  ->  Parallel Index Scan using bench_zone_hour_obs_hour_idx on bench_zone_hour"""


@pytest.mark.parametrize("store, plan, summary", [
    ("postgres", PG_PLAN, "parallel index scan, 2,900 pages"),
    ("postgres", "Seq Scan on zone_hour_observation\n  Buffers: shared hit=1", "full table scan, 1 page"),
    ("mongo_collection", '{"stages": [{"stage": "IXSCAN"}], "executionStats": {"totalDocsExamined": 195409}}',
     "index scan, 195,409 documents"),
    ("mongo_timeseries", '{"stage": "UNPACK_TS_BUCKET", "executionStats": {"totalDocsExamined": 789}}', "789 buckets"),
    ("mongo_summary", None, None),
])
def test_plan_summaries_say_how_much_each_store_read(store, plan, summary):
    assert results.plan_summary(store, plan) == summary


def test_halves_round_up_as_on_the_slides():
    assert results.mb(93585408) == "89.3 MB"      # 89.25 MB exactly
    assert results.ms(0.115) == "0.12 ms" and results.ms(18.25) == "18.3 ms" and results.ms(1089.7) == "1.1 s"


def test_our_saved_results_come_with_the_code():
    bench, load = results.saved("benchmark"), results.saved("load_test")
    assert bench and load, "etl/results/ should hold the runs behind the presentation"
    text = "\n".join(results.benchmark_lines(bench) + results.load_test_lines(load, full=True))
    for q in ("Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"):
        assert f"\n{q} " in "\n" + text
    assert "fastest" in text and "Flow Explorer" in text and "Stops growing at" in text
    assert "0 failed" in text


def test_export_saves_this_databases_latest_runs(conn, tmp_path, monkeypatch):
    with conn.transaction(force_rollback=True):
        conn.execute("""INSERT INTO load_test_run (run_at, question, users, seconds, requests, failed,
                                                   requests_per_sec, median_ms, p95_ms)
                        VALUES ('2030-01-01', 'Flow Explorer', 1, 5, 100, 0, 20, 4, 6)""")
        conn.execute("""INSERT INTO benchmark_run (run_at, store, query_name, runs, cold_ms, median_ms, p95_ms)
                        VALUES ('2030-01-01', 'postgres', 'Q1 one zone, one hour', 3, 1, 0.5, 0.6)""")
        monkeypatch.setattr(results, "SAVED", tmp_path)
        monkeypatch.setattr(results, "pg_connect", lambda: _Borrowed(conn))
        monkeypatch.setattr(sys, "argv", ["results.py", "--export"])
        results.main()
        saved = json.loads((tmp_path / "load_test.json").read_text())
        assert saved["run_at"].startswith("2030-01-01") and saved["results"][0]["requests"] == 100
        assert json.loads((tmp_path / "benchmark.json").read_text())["results"][0]["median_ms"] == 0.5


class _Borrowed:
    """The test's connection, lent to main() without it closing it."""
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, *exc):
        return False
