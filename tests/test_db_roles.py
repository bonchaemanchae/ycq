"""Database roles (sql/015, etl/setup_db.py) and row-level security on plans
(sql/016).

A login role made the same way as the API's (ensure_app_role), so the real
one's password is never touched, connected to the test database. It can read
everything but write only users and plans, the whole app must still work
through it, and it only ever reaches the calling user's plans.
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
    analyst_id = r.json()["user_id"]
    analyst = login(api_client, "role-check@test.local")
    r = api_client.post("/views", headers=analyst, json={
        "name": "Mine", "page": "dashboard", "filters": {"zoneIds": [1]}})
    assert r.status_code == 201, r.text
    assert api_client.post("/plans", json={"name": "Theirs"}, headers=analyst).status_code == 201
    # The Users section counts everyone's plans: row-level security lets admins read them
    users = {u["user_id"]: u for u in api_client.get("/admin/users", headers=admin).json()}
    assert users[analyst_id]["plans"] == 1
    r = api_client.delete(f"/admin/users/{analyst_id}", headers=admin)
    assert r.status_code == 200, r.text
    assert (r.json()["deleted_views"], r.json()["deleted_plans"]) == (1, 1)
    assert db.execute("SELECT count(*) FROM allocation_plan WHERE owner_user_id = %s",
                      (analyst_id,)).fetchone() == (0,)


# --- row-level security on plans (sql/016) -------------------------------------

PLAN_TABLES = ("allocation_plan", "allocation_plan_version", "allocation_plan_version_borough",
               "allocation_result", "v_plan_summary")


def as_user(conn, user_id):
    """What api/auth.py does for each request (None: what the pool resets to)."""
    conn.execute("SELECT set_config('app.user_id', %s, false)", ("" if user_id is None else str(user_id),))


def visible_plans(conn) -> dict[str, set[int]]:
    """The plan ids each plan table shows, with no owner filter at all."""
    return {t: {p for (p,) in conn.execute(f"SELECT DISTINCT allocation_plan_id FROM {t}")}
            for t in PLAN_TABLES}


@pytest.fixture
def plans(api_client, db, make_user):
    """Ana and Bo (analysts) and Boss (admin); Ana and Bo each save a plan
    with one version through the API."""
    manhattan = db.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'").fetchone()[0]
    settings = {"fleet_size": 7, "iso_dow": 1, "start_hour": 8, "end_hour": 9,
                "borough_ids": [manhattan], "max_zones_per_hour": 2, "min_sample": 0}
    ids = {"boss": make_user("boss@test.local", "admin")}
    for name in ("ana", "bo"):
        ids[name] = make_user(f"{name}@test.local", "analyst")
        headers = login(api_client, f"{name}@test.local")
        plan = api_client.post("/plans", json={"name": name}, headers=headers).json()["allocation_plan_id"]
        r = api_client.post(f"/plans/{plan}/versions", json={"settings": settings}, headers=headers)
        assert r.status_code == 201, r.text
        ids[f"{name}_plan"] = plan
    return ids


def test_each_user_sees_only_their_own_plans_even_without_a_where(api_conn, plans):
    as_user(api_conn, plans["ana"])
    assert visible_plans(api_conn) == {t: {plans["ana_plan"]} for t in PLAN_TABLES}
    as_user(api_conn, plans["bo"])
    assert visible_plans(api_conn) == {t: {plans["bo_plan"]} for t in PLAN_TABLES}


def test_no_user_sees_no_plans(api_conn, plans):
    as_user(api_conn, None)
    assert visible_plans(api_conn) == {t: set() for t in PLAN_TABLES}


def test_admins_read_every_plan_but_change_only_their_own(api_conn, plans, db):
    as_user(api_conn, plans["boss"])
    assert visible_plans(api_conn)["allocation_plan"] >= {plans["ana_plan"], plans["bo_plan"]}
    assert api_conn.execute("UPDATE allocation_plan SET name = 'boss was here' WHERE allocation_plan_id = %s",
                            (plans["ana_plan"],)).rowcount == 0
    assert db.execute("SELECT name FROM allocation_plan WHERE allocation_plan_id = %s",
                      (plans["ana_plan"],)).fetchone() == ("ana",)


@pytest.mark.parametrize("statement", [
    "UPDATE allocation_plan SET name = 'mine now' WHERE allocation_plan_id = %(bo_plan)s",
    "DELETE FROM allocation_plan WHERE allocation_plan_id = %(bo_plan)s",
    "UPDATE allocation_plan_version SET note = 'x' WHERE allocation_plan_id = %(bo_plan)s",
    "DELETE FROM allocation_result WHERE allocation_plan_id = %(bo_plan)s",
])
def test_someone_elses_plan_cannot_be_changed(api_conn, plans, db, statement):
    before = db.execute("SELECT count(*), max(name) FROM allocation_plan WHERE allocation_plan_id = %s",
                        (plans["bo_plan"],)).fetchone()
    as_user(api_conn, plans["ana"])
    assert api_conn.execute(statement, plans).rowcount == 0      # Bo's rows aren't there for Ana
    assert db.execute("SELECT count(*), max(name) FROM allocation_plan WHERE allocation_plan_id = %s",
                      (plans["bo_plan"],)).fetchone() == before


@pytest.mark.parametrize("statement", [
    "INSERT INTO allocation_plan (owner_user_id, name) VALUES (%(bo)s, 'for Bo')",
    "UPDATE allocation_plan SET owner_user_id = %(bo)s WHERE allocation_plan_id = %(ana_plan)s",
    """INSERT INTO allocation_plan_version (allocation_plan_id, version_no, fleet_size, iso_dow,
                                            start_hour, end_hour)
       VALUES (%(bo_plan)s, 99, 1, 1, 8, 8)""",
])
def test_rows_cannot_be_written_into_someone_elses_plan(api_conn, plans, statement):
    as_user(api_conn, plans["ana"])
    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with api_conn.transaction(force_rollback=True):
            api_conn.execute(statement, plans)


def test_the_owner_is_still_unrestricted(db):
    """The loader, the tests and psql keep the owner, which imports and
    rebuilds need."""
    assert db.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone() == (True,)
    with db.transaction(force_rollback=True):
        db.execute("CREATE TABLE owner_can (i int)")
