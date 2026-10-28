"""Administration routes: import history, rejected rows, reconciliation runs.

Uses the sample months from conftest. The query functions are called
directly with a test connection; no web server is started.
"""
import math
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


def test_rejected_rows_filtered_by_code(conn):
    jan = admin.list_imports(conn)[0]["import_batch_id"]
    page = admin.list_rejected(conn, jan, "R7")
    assert [r["source_row_number"] for r in page["rows"]] == \
        sorted(row for row, code in JANUARY_REJECTS.items() if code == "R7")
    assert page["total"] == len(page["rows"])
    every = admin.list_rejected(conn, jan)
    assert every["total"] == len(JANUARY_REJECTS)
    assert [r["source_row_number"] for r in every["rows"]] == sorted(JANUARY_REJECTS)


def test_rejected_rows_paging(conn, monkeypatch):
    jan = admin.list_imports(conn)[0]["import_batch_id"]
    monkeypatch.setattr(admin, "PAGE_SIZE", 3)
    first, second = admin.list_rejected(conn, jan, page=1), admin.list_rejected(conn, jan, page=2)
    assert len(first["rows"]) == 3
    assert first["pages"] == math.ceil(len(JANUARY_REJECTS) / 3)
    assert not {r["source_row_number"] for r in first["rows"]} & \
        {r["source_row_number"] for r in second["rows"]}


def test_rejected_rows_unknown_batch(conn):
    with pytest.raises(LookupError):
        admin.list_rejected(conn, 999_999)


def test_rejected_numbers_are_text_so_nan_is_safe(conn):
    jan = admin.list_imports(conn)[0]["import_batch_id"]
    conn.execute(
        """INSERT INTO rejected_trip (import_batch_id, source_row_number, reason_code, trip_distance)
           VALUES (%s, 1000, 'R9', 'NaN')""", (jan,))
    row = admin.list_rejected(conn, jan, "R9")["rows"][0]
    assert row["trip_distance"] == "NaN"


def test_reconciliation_newest_first(conn):
    conn.execute("INSERT INTO reconciliation_run (month, passed) VALUES ('2026-01-01', true)")
    conn.execute("INSERT INTO reconciliation_run (month, passed) VALUES ('2026-01-01', false)")
    runs = admin.list_reconciliation(conn)
    assert runs[0]["passed"] is False and runs[1]["passed"] is True
    assert runs[0]["reconciliation_run_id"] > runs[1]["reconciliation_run_id"]
    assert runs[0]["month"] == "2026-01"
