"""Test setup.

The tests build their own databases, `ycq_test` in both PostgreSQL and
MongoDB, inside the same Docker containers as the real ones. The real `ycq`
databases are never touched. Each run starts from empty: the test databases
are dropped and rebuilt, the schema is applied, three test zones are added,
and small hand-made January, February and March files are imported with the
real scripts.

Needs `docker compose up -d`. MongoDB tests are skipped if MongoDB can't be
reached.
"""
import os
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest
from dotenv import load_dotenv
from pymongo import MongoClient

import sample_data

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

TEST_DB = os.getenv("YCQ_TEST_DB", "ycq_test")
REAL_DB = os.getenv("POSTGRES_DB", "ycq")
if TEST_DB in (REAL_DB, os.getenv("MONGO_DB", "ycq")):
    raise RuntimeError("YCQ_TEST_DB must not be the real database")

# The scripts read these, so they work on the test databases.
TEST_ENV = {**os.environ, "POSTGRES_DB": TEST_DB, "MONGO_DB": TEST_DB}

ZONES_SQL = """
INSERT INTO borough (name) VALUES ('Manhattan'), ('Unknown'), ('N/A');
INSERT INTO taxi_zone (location_id, borough_id, zone_name, service_zone, geom)
SELECT id, (SELECT borough_id FROM borough WHERE name = b), name, 'Yellow Zone',
       ST_Multi(ST_MakeEnvelope(id, 0, id + 1, 1, 4326))
FROM (VALUES (1, 'Manhattan', 'Zone A'), (2, 'Manhattan', 'Zone B'),
             (3, 'Manhattan', 'Zone C')) z(id, b, name);
INSERT INTO taxi_zone (location_id, borough_id, zone_name, service_zone)
VALUES (264, (SELECT borough_id FROM borough WHERE name = 'Unknown'), 'Unknown', 'N/A'),
       (265, (SELECT borough_id FROM borough WHERE name = 'N/A'), 'Outside of NYC', 'N/A');
"""


def pg_connect(dbname=TEST_DB, **kwargs):
    return psycopg.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        user=os.getenv("POSTGRES_USER", "ycq"),
        password=os.environ["POSTGRES_PASSWORD"],
        dbname=dbname,
        **kwargs,
    )


def run(script, *args):
    """Run one of the repo's scripts against the test databases."""
    return subprocess.run(
        [sys.executable, str(ROOT / script), *args],
        env=TEST_ENV, capture_output=True, text=True, timeout=300,
    )


def run_ok(script, *args):
    result = run(script, *args)
    assert result.returncode == 0, f"{script} failed:\n{result.stdout}\n{result.stderr}"
    return result


@pytest.fixture(scope="session")
def files(tmp_path_factory):
    d = tmp_path_factory.mktemp("tlc")
    return {
        "2026-01": sample_data.write(sample_data.JANUARY, d / "jan.parquet"),
        "2026-02": sample_data.write(sample_data.FEBRUARY, d / "feb.parquet"),
        "2026-03": sample_data.write(sample_data.MARCH, d / "mar.parquet"),
        "jan_other": sample_data.write(sample_data.JANUARY[:5], d / "jan_other.parquet"),
    }


@pytest.fixture(scope="session")
def loaded(files):
    """Fresh test database with all three sample months imported and summarised."""
    with pg_connect(REAL_DB, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
        admin.execute(f'CREATE DATABASE "{TEST_DB}"')
    run_ok("etl/setup_db.py")
    with pg_connect(autocommit=True) as conn:
        conn.execute(ZONES_SQL)
    for month in ("2026-01", "2026-02", "2026-03"):
        run_ok("etl/import_month.py", "--month", month, "--file", str(files[month]))
        run_ok("etl/build_aggregates.py", "--month", month)
    return files


@pytest.fixture
def db(loaded):
    with pg_connect(autocommit=True) as conn:
        yield conn


@pytest.fixture(scope="session")
def mongo(loaded):
    client = MongoClient(
        host=os.getenv("MONGO_HOST", "localhost"),
        port=int(os.getenv("MONGO_PORT", "27017")),
        username=os.getenv("MONGO_USER", "ycq"),
        password=os.getenv("MONGO_PASSWORD"),
        serverSelectionTimeoutMS=3000,
        tz_aware=True,
    )
    try:
        client.admin.command("ping")
    except Exception as e:
        pytest.skip(f"MongoDB not reachable: {e}")
    client.drop_database(TEST_DB)
    for month in ("2026-01", "2026-02", "2026-03"):
        run_ok("etl/load_mongo.py", "--month", month)
    yield client[TEST_DB]
    client.close()
