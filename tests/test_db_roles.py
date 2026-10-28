"""Database roles (sql/015, etl/setup_db.py): the API's login can read
everything and write only users and plans.

A login role made the same way as the API's (ensure_app_role), so the real
one's password is never touched, connected to the test database. It must not
be able to change anything else, and the whole app must still work through it.
"""
import os
import sys

import psycopg
import pytest
from psycopg import errors

from conftest import JWT_TEST_SECRET, PASSWORD, ROOT, TEST_DB, login, pg_connect

sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT))
from setup_db import ensure_app_role  # noqa: E402

ROLE, ROLE_PASSWORD = "ycq_app_test", "test-only-api-password"


@pytest.fixture(scope="module")
def api_conn(loaded):
    with pg_connect(autocommit=True) as owner:
        ensure_app_role(owner, ROLE, ROLE_PASSWORD)
        conn = psycopg.connect(host=os.getenv("POSTGRES_HOST", "localhost"),
                               port=os.getenv("POSTGRES_PORT", "5432"), dbname=TEST_DB,
                               user=ROLE, password=ROLE_PASSWORD, autocommit=True)
        yield conn
        conn.close()
        owner.execute(f"DROP ROLE {ROLE}")     # it owns nothing and holds no grants of its own


@pytest.fixture
def api_client(api_conn, mongo, monkeypatch):
    """The real app, with every request on the API role's connection."""
    from fastapi.testclient import TestClient

    from api import db as api_db
    from api.main import app

    monkeypatch.setenv("JWT_SECRET", JWT_TEST_SECRET)
    monkeypatch.setenv("MONGO_DB", TEST_DB)
    app.dependency_overrides[api_db.get_pg] = lambda: api_conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_the_api_role_is_not_a_superuser(api_conn):
    row = api_conn.execute(
        """SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
                  pg_has_role(current_user, 'ycq_write', 'MEMBER'),
                  has_schema_privilege('public', 'CREATE')
           FROM pg_roles WHERE rolname = current_user""").fetchone()
    assert row == (False, False, False, False, True, False)


def test_the_api_role_reads_every_table_and_view(api_conn):
    relations = [name for (name,) in api_conn.execute(
        """SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
           ORDER BY 1""")]
    assert {"trip", "zone_hour_observation", "od_summary", "v_plan_summary", "app_user"} <= set(relations)
    for name in relations:
        api_conn.execute(f'SELECT 1 FROM "{name}" LIMIT 1')     # raises if not allowed


@pytest.mark.parametrize("statement", [
    "CREATE TABLE sneaky (i int)",
    "DROP TABLE trip",
    "ALTER TABLE app_user ADD COLUMN sneaky int",
    "TRUNCATE allocation_plan",
    "DELETE FROM import_batch",
    "UPDATE taxi_zone SET zone_name = 'x'",
    "INSERT INTO validation_code VALUES ('R0', 'reject', 'x')",
    "DELETE FROM reconciliation_run",
    "REFRESH MATERIALIZED VIEW od_summary",
    "CREATE ROLE sneaky",
    "ALTER TABLE allocation_result DISABLE TRIGGER USER",
])
def test_the_api_role_cannot_change_data_or_schema_it_does_not_own(api_conn, statement):
    with pytest.raises(errors.InsufficientPrivilege):
        with api_conn.transaction(force_rollback=True):
            api_conn.execute(statement)


def test_the_whole_app_works_as_the_api_role(api_client, db, make_user):
    """Every kind of write the API makes, and the pages' reads."""
    make_user("boss@test.local", "admin")
    admin = login(api_client, "boss@test.local")
    manhattan = db.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'").fetchone()[0]

    for path in ("/health", "/zones", "/dashboard/context", "/admin/imports", "/admin/reconciliation",
                 "/admin/benchmarks", "/admin/users", "/plans"):
        assert api_client.get(path, headers=admin).status_code == 200, path

    # Plans: create, save two versions, rename, compare, delete
    plan = api_client.post("/plans", json={"name": "Role check"}, headers=admin).json()["allocation_plan_id"]
    settings = {"fleet_size": 7, "iso_dow": 1, "start_hour": 8, "end_hour": 9,
                "borough_ids": [manhattan], "max_zones_per_hour": 2, "min_sample": 0}
    assert api_client.post("/plans/preview", json=settings, headers=admin).status_code == 200
    for _ in range(2):
        r = api_client.post(f"/plans/{plan}/versions", json={"settings": settings}, headers=admin)
        assert r.status_code == 201, r.text
    assert api_client.patch(f"/plans/{plan}", json={"name": "Renamed"}, headers=admin).status_code == 200
    r = api_client.get(f"/plans/{plan}/compare?from_version=1&to_version=2", headers=admin)
    assert r.status_code == 200, r.text
    assert api_client.delete(f"/plans/{plan}", headers=admin).status_code == 204

    # Users: an admin adds an analyst, who logs in and saves a view; then the
    # admin deletes them (both databases)
    r = api_client.post("/admin/users", headers=admin, json={
        "email": "role-check@test.local", "display_name": "Role Check", "role": "analyst",
        "password": PASSWORD})
    assert r.status_code == 201, r.text
    analyst = login(api_client, "role-check@test.local")
    r = api_client.post("/views", headers=analyst, json={
        "name": "Mine", "page": "dashboard", "filters": {"zoneIds": [1]}})
    assert r.status_code == 201, r.text
    r = api_client.delete(f"/admin/users/{r.json()['ownerUserId']}", headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["deleted_views"] == 1


def test_the_owner_is_still_unrestricted(db):
    """The loader, the tests and psql keep the owner, which imports and
    rebuilds need."""
    assert db.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone() == (True,)
    with db.transaction(force_rollback=True):
        db.execute("CREATE TABLE owner_can (i int)")
