"""Deleting a user across PostgreSQL and MongoDB (api/users.py), including
what happens when either database fails part way.

The user owns a saved plan with two versions, so the deletion also proves the
cascade gets past the triggers that protect saved plan history.
"""
import sys
import threading
from datetime import datetime, timezone

import pytest
from pymongo.errors import AutoReconnect

from conftest import ROOT, login, pg_connect

sys.path.insert(0, str(ROOT))
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


def test_a_view_saved_during_deletion_is_swept_up(db, views, victim):
    """A request that passed the login check just before the user was
    deactivated saves a view after step 2. Step 4 must remove it."""
    user_id, plan_id = victim
    calls = []

    def delete_then_concurrent_save(query):
        deleted = views.delete_many(query)
        if not calls:
            save_view(views, user_id, "Saved mid-deletion")
        calls.append(query)
        return deleted

    result = users.delete_user(db, Views(views, delete_then_concurrent_save), user_id)
    assert len(calls) == 2 and result["deleted_views"] == 3
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
