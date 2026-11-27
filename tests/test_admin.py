"""Administration routes for Data health: import history and reconciliation runs.

Uses the sample months from conftest. The query functions are called
directly with a test connection; no web server is started.
"""
import sys
from collections import Counter

import pytest

from conftest import ROOT, pg_connect
from sample_data import JANUARY, JANUARY_REJECTS

sys.path.insert(0, str(ROOT))
from api.routers import admin  # noqa: E402


@pytest.fixture
def conn(loaded):
    c = pg_connect()
    yield c
    c.rollback()
    c.close()


def test_imports_lists_every_batch_with_its_counts(conn):
    batches = admin.list_imports(conn)
    assert [b["month"] for b in batches] == ["2026-01", "2026-02", "2026-03"]
    jan = batches[0]
    assert jan["rows_read"] == len(JANUARY)
    assert jan["rows_accepted"] + jan["rows_rejected"] == jan["rows_read"]
    assert jan["status"] == "completed"


def test_reject_reasons_add_up_to_rejected_rows(conn):
    for b in admin.list_imports(conn):
        assert sum(r["rows"] for r in b["rejects"]) == b["rows_rejected"]
    jan = admin.list_imports(conn)[0]
    assert {r["code"]: r["rows"] for r in jan["rejects"]} == Counter(JANUARY_REJECTS.values())


def test_warning_reasons_match_trip_warning(conn):
    jan = admin.list_imports(conn)[0]
    total = conn.execute(
        "SELECT count(*) FROM trip_warning WHERE import_batch_id = %s",
        (jan["import_batch_id"],)).fetchone()[0]
    assert sum(r["rows"] for r in jan["warnings"]) == total
    assert all(r["description"] for r in jan["warnings"])


def test_reconciliation_newest_first(conn):
    conn.execute("INSERT INTO reconciliation_run (month, passed) VALUES ('2026-01-01', true)")
    conn.execute("INSERT INTO reconciliation_run (month, passed) VALUES ('2026-01-01', false)")
    runs = admin.list_reconciliation(conn)
    assert runs[0]["passed"] is False and runs[1]["passed"] is True
    assert runs[0]["reconciliation_run_id"] > runs[1]["reconciliation_run_id"]
    assert runs[0]["month"] == "2026-01"
