"""Import rules: every reject and warning code, counts and re-imports."""
import psycopg
import pytest

from conftest import run
from sample_data import JANUARY, JANUARY_REJECTS, JANUARY_WARNINGS


def jan_batch(db):
    return db.execute(
        "SELECT import_batch_id FROM import_batch WHERE file_month = '2026-01-01'"
    ).fetchone()[0]


def test_accepted_plus_rejected_equals_rows_read(db):
    read, accepted, rejected, warned = db.execute(
        """SELECT rows_read, rows_accepted, rows_rejected, rows_warned
           FROM import_batch WHERE file_month = '2026-01-01'"""
    ).fetchone()
    assert read == len(JANUARY) == 28
    assert accepted + rejected == read
    assert rejected == len(JANUARY_REJECTS)
    assert warned == len(JANUARY_WARNINGS)


def test_each_rejected_row_has_the_right_reason(db):
    got = dict(db.execute(
        "SELECT source_row_number, reason_code FROM rejected_trip WHERE import_batch_id = %s",
        (jan_batch(db),),
    ).fetchall())
    assert got == JANUARY_REJECTS


def test_each_warned_row_has_the_right_warnings(db):
    got = {}
    for row, code in db.execute(
        "SELECT source_row_number, code FROM trip_warning WHERE import_batch_id = %s",
        (jan_batch(db),),
    ):
        got.setdefault(row, set()).add(code)
    assert got == JANUARY_WARNINGS


def test_reversal_rejected_and_original_kept_once(db):
    batch = jan_batch(db)
    # Row 1 is the original of reversal row 10.
    assert db.execute(
        "SELECT count(*) FROM trip WHERE import_batch_id = %s AND source_row_number = 1", (batch,)
    ).fetchone()[0] == 1
    # Two reversals (25, 26) of one original (24): only one is rejected.
    assert db.execute(
        "SELECT count(*) FROM rejected_trip WHERE import_batch_id = %s AND source_row_number IN (25, 26)",
        (batch,),
    ).fetchone()[0] == 1


def test_rate_code_99_stored_as_null(db):
    assert db.execute(
        "SELECT rate_code_id FROM trip WHERE import_batch_id = %s AND source_row_number = 22",
        (jan_batch(db),),
    ).fetchone()[0] is None


def test_unknown_dropoff_zone_kept_as_null(db):
    assert db.execute(
        "SELECT dropoff_location_id FROM trip WHERE import_batch_id = %s AND source_row_number = 18",
        (jan_batch(db),),
    ).fetchone()[0] is None


def test_same_file_twice_is_refused(loaded, db):
    result = run("etl/import_month.py", "--month", "2026-01", "--file", str(loaded["2026-01"]))
    assert result.returncode == 2
    assert "this file was already imported" in result.stderr
    assert db.execute("SELECT count(*) FROM import_batch").fetchone()[0] == 3


def test_second_file_for_same_month_is_refused(loaded, db):
    result = run("etl/import_month.py", "--month", "2026-01", "--file", str(loaded["jan_other"]))
    assert result.returncode == 2
    assert "2026-01 was already imported" in result.stderr
    assert db.execute("SELECT count(*) FROM import_batch").fetchone()[0] == 3


def test_database_refuses_second_batch_for_a_month(db):
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute(
            """INSERT INTO import_batch (source_file, file_month, checksum_sha256)
               VALUES ('other.parquet', '2026-01-01', repeat('f', 64))"""
        )
