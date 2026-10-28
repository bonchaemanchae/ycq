"""Creating users, and deleting a user across PostgreSQL and MongoDB
(api/users.py), including what happens when either database fails part way.

The user owns a saved plan with two versions, so the deletion also proves the
cascade gets past the triggers that protect saved plan history.
"""
import sys
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pymongo.errors import AutoReconnect

from conftest import PASSWORD, ROOT, login, pg_connect

sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import seed_users  # noqa: E402
from api import saved_views, users  # noqa: E402


@pytest.fixture
def views(mongo):
    coll = mongo[saved_views.COLLECTION]
    coll.delete_many({})
    yield coll
    coll.delete_many({})


def save_plan(db, owner: int) -> int:
    """A plan with versions 1 and 2, each one zone-hour of 2 taxis."""
    with db.transaction():
        (plan_id,) = db.execute(
            "INSERT INTO allocation_plan (owner_user_id, name) VALUES (%s, 'Plan') "
            "RETURNING allocation_plan_id", (owner,)).fetchone()
        for version in (1, 2):
            db.execute(
                """INSERT INTO allocation_plan_version
                       (allocation_plan_id, version_no, fleet_size, iso_dow, start_hour, end_hour)
                   VALUES (%s, %s, 2, 1, 8, 8)""", (plan_id, version))
            db.execute(
                """INSERT INTO allocation_plan_version_borough
                   SELECT %s, %s, borough_id FROM borough WHERE name = 'Manhattan'""",
                (plan_id, version))
            db.execute("INSERT INTO allocation_result VALUES (%s, %s, 8, 1, 2, 2, 0.5, 1, 30, 'test')",
                       (plan_id, version))
    return plan_id


def save_view(views, owner: int, name: str) -> None:
    now = datetime.now(timezone.utc)
    views.insert_one({"ownerUserId": owner, "name": name, "page": "flows",
                      "filters": {}, "createdAt": now, "updatedAt": now})


def footprint(db, views, user_id: int, plan_id: int) -> dict:
    """Everything stored for a user, in both databases."""
    counts = {
        "app_user": ("SELECT count(*) FROM app_user WHERE user_id = %s", user_id),
        "app_user_role": ("SELECT count(*) FROM app_user_role WHERE user_id = %s", user_id),
        "allocation_plan": ("SELECT count(*) FROM allocation_plan WHERE owner_user_id = %s", user_id),
        "versions": ("SELECT count(*) FROM allocation_plan_version WHERE allocation_plan_id = %s",
                     plan_id),
        "version_boroughs": ("SELECT count(*) FROM allocation_plan_version_borough "
                             "WHERE allocation_plan_id = %s", plan_id),
        "results": ("SELECT count(*) FROM allocation_result WHERE allocation_plan_id = %s", plan_id),
    }
    found = {name: db.execute(sql, (value,)).fetchone()[0] for name, (sql, value) in counts.items()}
    return {**found, "views": views.count_documents({"ownerUserId": user_id})}


GONE = {"app_user": 0, "app_user_role": 0, "allocation_plan": 0, "versions": 0,
        "version_boroughs": 0, "results": 0, "views": 0}
FULL = {"app_user": 1, "app_user_role": 1, "allocation_plan": 1, "versions": 2,
        "version_boroughs": 2, "results": 2, "views": 2}


@pytest.fixture
def victim(db, views, make_user):
    """An analyst with a two-version plan and two saved views, and a bystander
    with the same, who must be left untouched."""
    user_id = make_user("victim@test.local", "analyst")
    other = make_user("bystander@test.local", "analyst")
    plan_id, other_plan = save_plan(db, user_id), save_plan(db, other)
    for owner in (user_id, other):
        save_view(views, owner, "Morning")
        save_view(views, owner, "Evening")
    assert footprint(db, views, user_id, plan_id) == FULL
    yield user_id, plan_id
    assert footprint(db, views, other, other_plan) == FULL


def is_active(db, user_id):
    return db.execute("SELECT is_active FROM app_user WHERE user_id = %s", (user_id,)).fetchone()[0]


class Views:
    """The real collection, with delete_many replaced for one test."""

    def __init__(self, real, delete_many):
        self.real, self.delete_many = real, delete_many


def test_deletion_removes_the_user_from_both_databases(db, views, victim):
    user_id, plan_id = victim
    assert users.delete_user(db, views, user_id) == {
        "user_id": user_id, "deleted_views": 2, "deleted_plans": 1}
    assert footprint(db, views, user_id, plan_id) == GONE


def test_unknown_user(db, views):
    with pytest.raises(users.UserNotFound):
        users.delete_user(db, views, 0)


def test_mongodb_failure_keeps_everything_and_a_retry_finishes(db, views, victim):
    user_id, plan_id = victim

    def fail(_filter):
        raise AutoReconnect("injected MongoDB outage")

    with pytest.raises(users.DeletionIncomplete, match="views could not be deleted"):
        users.delete_user(db, Views(views, fail), user_id)
    assert footprint(db, views, user_id, plan_id) == FULL
    assert is_active(db, user_id) is False          # can't log in or save meanwhile

    users.delete_user(db, views, user_id)
    assert footprint(db, views, user_id, plan_id) == GONE


def test_postgres_failure_keeps_the_user_to_retry_from(db, views, victim):
    """A real database error, from a trigger that refuses this one deletion."""
    user_id, plan_id = victim
    db.execute("""CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
                  BEGIN RAISE EXCEPTION 'injected PostgreSQL failure'; END $$""")
    db.execute(f"""CREATE TRIGGER refuse_delete BEFORE DELETE ON app_user FOR EACH ROW
                   WHEN (OLD.user_id = {user_id}) EXECUTE FUNCTION refuse_delete()""")
    try:
        with pytest.raises(users.DeletionIncomplete, match="user could not be"):
            users.delete_user(db, views, user_id)
        assert footprint(db, views, user_id, plan_id) == {**FULL, "views": 0}
        assert is_active(db, user_id) is False
    finally:
        db.execute("DROP TRIGGER refuse_delete ON app_user")
        db.execute("DROP FUNCTION refuse_delete()")

    users.delete_user(db, views, user_id)
    assert footprint(db, views, user_id, plan_id) == GONE


def test_a_view_being_saved_when_deletion_starts_is_deleted_too(db, views, victim):
    """The save has checked the owner and is storing the view when the
    deletion starts. The deletion must wait for it and then delete it, not
    finish first and leave a view whose owner is gone."""
    user_id, plan_id = victim
    storing, errors = threading.Event(), []

    def slow_insert(doc):
        storing.set()
        time.sleep(1)          # the deletion starts meanwhile
        return views.insert_one(doc)

    def save():
        try:
            with pg_connect(autocommit=True) as conn:
                saved_views.create_view(
                    SimpleNamespace(insert_one=slow_insert), conn, user_id,
                    saved_views.ViewCreate.model_validate(
                        {"name": "Saved mid-deletion", "page": "dashboard", "filters": {}}))
        except Exception as e:
            errors.append(e)

    saver = threading.Thread(target=save)
    saver.start()
    assert storing.wait(10)
    result = users.delete_user(db, views, user_id)
    saver.join(10)
    assert errors == [] and result["deleted_views"] == 3
    assert footprint(db, views, user_id, plan_id) == GONE


def test_the_last_active_admin_cannot_be_deleted(db, views, make_user):
    only = make_user("boss@test.local", "admin")
    make_user("former@test.local", "admin", active=False)
    with pytest.raises(users.LastAdmin):
        users.delete_user(db, views, only)
    assert is_active(db, only) is True
    make_user("second@test.local", "admin")
    users.delete_user(db, views, only)


def test_two_admins_deleting_each_other_at_once_leave_one(views, make_user):
    """Each thread has its own connection, and both start together. The admin
    rows are locked, so the second deletion sees the first one's result."""
    a, b = make_user("a@test.local", "admin"), make_user("b@test.local", "admin")
    start, outcome = threading.Barrier(2), {}

    def delete(target):
        with pg_connect(autocommit=True) as conn:
            start.wait()
            try:
                users.delete_user(conn, views, target)
                outcome[target] = "deleted"
            except users.LastAdmin:
                outcome[target] = "refused"

    threads = [threading.Thread(target=delete, args=(t,)) for t in (a, b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert sorted(outcome.values()) == ["deleted", "refused"]


# --- the routes ----------------------------------------------------------------

def test_admin_deletes_a_user_through_the_api(client, db, views, victim, make_user):
    user_id, plan_id = victim
    make_user("boss@test.local", "admin")
    admin, theirs = login(client, "boss@test.local"), login(client, "victim@test.local")

    listed = {u["email"]: u for u in client.get("/admin/users", headers=admin).json()}
    assert listed["victim@test.local"]["plans"] == 1
    assert listed["victim@test.local"]["roles"] == ["analyst"]

    r = client.delete(f"/admin/users/{user_id}", headers=admin)
    assert r.status_code == 200 and r.json()["deleted_views"] == 2
    assert footprint(db, views, user_id, plan_id) == GONE
    assert client.get("/auth/me", headers=theirs).status_code == 401
    assert client.delete(f"/admin/users/{user_id}", headers=admin).status_code == 404


def test_admin_cannot_delete_themselves(client, make_user):
    me = make_user("boss@test.local", "admin")
    make_user("second@test.local", "admin")     # so the last-admin rule isn't what stops it
    headers = login(client, "boss@test.local")
    r = client.delete(f"/admin/users/{me}", headers=headers)
    assert r.status_code == 409 and "your own account" in r.json()["detail"]
    assert client.get("/auth/me", headers=headers).status_code == 200


def test_an_incomplete_deletion_is_reported_as_retryable(client, views, victim, make_user,
                                                          monkeypatch):
    user_id, _ = victim
    make_user("boss@test.local", "admin")

    def fail(*_):
        raise users.DeletionIncomplete("Try again.")

    monkeypatch.setattr(users, "delete_user", fail)
    r = client.delete(f"/admin/users/{user_id}", headers=login(client, "boss@test.local"))
    assert r.status_code == 503 and r.json()["detail"] == "Try again."


# --- creating users ------------------------------------------------------------

NEW = "new@test.local"


@pytest.fixture
def admin(client, db, make_user):
    """An admin's Authorization header; any account made under NEW is removed."""
    make_user("boss@test.local", "admin")
    db.execute("DELETE FROM app_user WHERE lower(email) = %s", (NEW,))
    yield login(client, "boss@test.local")
    db.execute("DELETE FROM app_user WHERE lower(email) = %s", (NEW,))


def accounts_named(db, email):
    return db.execute("SELECT count(*) FROM app_user WHERE lower(email) = lower(%s)",
                      (email,)).fetchone()[0]


def new_user(**changes):
    return {"email": NEW, "display_name": "New Analyst", "role": "analyst",
            "password": PASSWORD, **changes}


def test_admin_creates_a_user_who_can_log_in(client, db, admin):
    r = client.post("/admin/users", headers=admin, json=new_user(email="  New@Test.local "))
    assert r.status_code == 201
    assert r.json() == {"user_id": r.json()["user_id"], "email": NEW, "display_name": "New Analyst",
                        "is_active": True, "roles": ["analyst"], "plans": 0}   # no hash
    (stored,) = db.execute("SELECT password_hash FROM app_user WHERE email = %s", (NEW,)).fetchone()
    assert stored.startswith("$argon2id$")
    me = client.get("/auth/me", headers=login(client, NEW))
    assert me.json()["roles"] == ["analyst"]
    assert client.get("/admin/users", headers=login(client, NEW)).status_code == 403


def test_an_email_in_use_is_refused_in_any_case(client, db, admin):
    assert client.post("/admin/users", headers=admin, json=new_user()).status_code == 201
    r = client.post("/admin/users", headers=admin, json=new_user(email="NEW@test.local", role="admin"))
    assert r.status_code == 409 and "already has an account" in r.json()["detail"]
    assert accounts_named(db, NEW) == 1


def test_the_default_accounts_are_left_to_the_loader(db):
    assert users.RESERVED_EMAILS == {email for email, *_ in seed_users.ACCOUNTS}
    for email in seed_users.ACCOUNTS[0][0].upper(), *users.RESERVED_EMAILS:
        before = accounts_named(db, email)
        with pytest.raises(users.EmailTaken, match="managed from .env"):
            users.create_user(db, email, "Imposter", "analyst", PASSWORD)
        assert accounts_named(db, email) == before


@pytest.mark.parametrize("password", ["short", "change-me-please-123"])
def test_a_weak_password_is_refused_before_writing(client, db, admin, password):
    r = client.post("/admin/users", headers=admin, json=new_user(password=password))
    assert r.status_code == 422 and "at least 12 characters" in r.json()["detail"]
    assert accounts_named(db, NEW) == 0


def test_an_unknown_role_leaves_no_user_without_a_role(client, db, admin):
    assert client.post("/admin/users", headers=admin,
                       json=new_user(role="superuser")).status_code == 422
    with pytest.raises(ValueError, match="unknown role"):
        users.create_user(db, NEW, "New", "superuser", PASSWORD)   # past the route's check
    assert accounts_named(db, NEW) == 0                              # the user insert rolled back


@pytest.mark.parametrize("body", [new_user(email="not-an-email"), new_user(display_name="  "),
                                  {**new_user(), "is_active": False}])
def test_invalid_requests_are_refused(client, db, admin, body):
    assert client.post("/admin/users", headers=admin, json=body).status_code == 422
    assert accounts_named(db, NEW) == 0
