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


# --- login and users (test_auth.py, test_users.py) ---------------------------

PASSWORD = "correct horse battery staple"
JWT_TEST_SECRET = "test-only-secret-" + "x" * 32


@pytest.fixture
def make_user(db):
    """make_user(email, *roles, active=True) -> user_id, with PASSWORD.
    The users (and, by cascade, their plans) are deleted after the test."""
    sys.path.insert(0, str(ROOT))
    from api.passwords import hash_password
    created = []

    def make(email, *roles, active=True):
        (user_id,) = db.execute(
            """INSERT INTO app_user (email, display_name, password_hash, is_active)
               VALUES (%s, %s, %s, %s) RETURNING user_id""",
            (email, email, hash_password(PASSWORD), active)).fetchone()
        for role in roles:
            db.execute("INSERT INTO app_user_role SELECT %s, role_id FROM app_role WHERE name = %s",
                       (user_id, role))
        created.append(user_id)
        return user_id

    yield make
    db.execute("DELETE FROM app_user WHERE user_id = ANY(%s)", (created,))


@pytest.fixture
def client(db, mongo, monkeypatch):
    """The real FastAPI app on the test databases: get_pg yields the test
    connection, and mongo() reads MONGO_DB on each call. Start-up (which
    would open the real connection pool) doesn't run."""
    sys.path.insert(0, str(ROOT))
    from fastapi.testclient import TestClient

    from api import db as api_db
    from api.main import app

    monkeypatch.setenv("JWT_SECRET", JWT_TEST_SECRET)
    monkeypatch.setenv("MONGO_DB", TEST_DB)
    app.dependency_overrides[api_db.get_pg] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def login(client, email, password=PASSWORD) -> dict:
    """Authorization header for a user, through the real login route."""
    r = client.post("/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}
