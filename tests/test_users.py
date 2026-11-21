"""User management (api/users.py, sql/019): inviting an account, setting it
up from a one-time link, and disabling and enabling it.

Admins never set passwords: the invited user sets their own. Accounts are
disabled, never deleted, so a disabled user's plans and saved views stay.
"""
import hashlib
import sys
import threading
from datetime import datetime, timezone

import psycopg
import pytest

from conftest import PASSWORD, ROOT, login, pg_connect

sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import seed_users  # noqa: E402
from api import mailer, saved_views, users  # noqa: E402

NEW = "new@test.local"
NEW_PASSWORD = "a-new-strong-password"


@pytest.fixture
def admin(client, db, make_user):
    """An admin's Authorization header; any account made under NEW is removed."""
    make_user("boss@test.local", "admin")
    db.execute("DELETE FROM app_user WHERE lower(email) = %s", (NEW,))
    yield login(client, "boss@test.local")
    db.execute("DELETE FROM app_user WHERE lower(email) = %s", (NEW,))


@pytest.fixture
def views(mongo):
    coll = mongo[saved_views.COLLECTION]
    coll.delete_many({})
    yield coll
    coll.delete_many({})


def new_user(**changes):
    return {"email": NEW, "display_name": "New Analyst", "role": "analyst", **changes}


def invite(client, admin, **changes) -> tuple[dict, str]:
    """Invite NEW; returns the account and the token from its link."""
    r = client.post("/admin/users", headers=admin, json=new_user(**changes))
    assert r.status_code == 201, r.text
    return r.json(), r.json()["invite"]["link"].split("#", 1)[1]


def accounts_named(db, email):
    return db.execute("SELECT count(*) FROM app_user WHERE lower(email) = lower(%s)",
                      (email,)).fetchone()[0]


def status_of(client, admin, email):
    return {u["email"]: u for u in client.get("/admin/users", headers=admin).json()}[email]["status"]


def can_log_in(client, email, password) -> bool:
    return client.post("/auth/login", json={"email": email, "password": password}).status_code == 200


# --- inviting ------------------------------------------------------------------

def test_an_invited_account_has_no_password_and_cannot_log_in(client, db, admin):
    account, token = invite(client, admin, email="  New@Test.local ")
    assert account["email"] == NEW and account["status"] == "invited"
    assert account["roles"] == ["analyst"] and account["invite_expires_at"] is not None
    assert account["invite"]["link"].startswith(mailer.app_url() + "/setup#")

    (stored,) = db.execute("SELECT password_hash FROM app_user WHERE email = %s", (NEW,)).fetchone()
    assert stored is None
    # Only the token's hash is stored, never the token itself
    (kept,) = db.execute("""SELECT token_sha256 FROM account_invite JOIN app_user USING (user_id)
                            WHERE email = %s""", (NEW,)).fetchone()
    assert kept == hashlib.sha256(token.encode()).hexdigest() and token not in kept
    for password in ("", "anything", PASSWORD):
        assert not can_log_in(client, NEW, password or "x")


def test_setting_up_from_the_link_sets_the_password_and_logs_in(client, admin):
    _, token = invite(client, admin)
    details = client.post("/auth/invite", json={"token": token})
    assert details.status_code == 200 and details.json()["email"] == NEW

    r = client.post("/auth/setup", json={"token": token, "password": NEW_PASSWORD})
    assert r.status_code == 200, r.text
    session = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.get("/auth/me", headers=session).json()["roles"] == ["analyst"]
    assert can_log_in(client, NEW, NEW_PASSWORD)
    assert status_of(client, admin, NEW) == "active"
    assert client.get("/admin/users", headers=session).status_code == 403   # an analyst

    # The link works once
    assert client.post("/auth/invite", json={"token": token}).status_code == 404
    assert client.post("/auth/setup", json={"token": token, "password": "another-password-1"}).status_code == 404
    assert can_log_in(client, NEW, NEW_PASSWORD)


@pytest.mark.parametrize("password", ["short", "change-me-please-123"])
def test_a_weak_password_is_refused_and_the_link_still_works(client, admin, password):
    _, token = invite(client, admin)
    r = client.post("/auth/setup", json={"token": token, "password": password})
    assert r.status_code == 422 and "at least 12 characters" in r.json()["detail"]
    assert client.post("/auth/setup", json={"token": token, "password": NEW_PASSWORD}).status_code == 200


def test_an_expired_link_is_refused(client, db, admin):
    _, token = invite(client, admin)
    db.execute("""UPDATE account_invite SET created_at = now() - interval '3 days',
                                            expires_at = now() - interval '1 second'
                  WHERE token_sha256 = %s""", (hashlib.sha256(token.encode()).hexdigest(),))
    assert client.post("/auth/invite", json={"token": token}).status_code == 404
    assert client.post("/auth/setup", json={"token": token, "password": NEW_PASSWORD}).status_code == 404
    assert status_of(client, admin, NEW) == "invited"


@pytest.mark.parametrize("token", ["x" * 43, "not-a-real-token-but-long-enough"])
def test_an_unknown_link_is_refused(client, token):
    assert client.post("/auth/invite", json={"token": token}).status_code == 404
    assert client.post("/auth/setup", json={"token": token, "password": NEW_PASSWORD}).status_code == 404


def test_a_new_link_replaces_the_old_one(client, admin):
    account, old = invite(client, admin)
    r = client.post(f"/admin/users/{account['user_id']}/invite", headers=admin)
    assert r.status_code == 200
    new = r.json()["invite"]["link"].split("#", 1)[1]
    assert new != old
    assert client.post("/auth/setup", json={"token": old, "password": NEW_PASSWORD}).status_code == 404
    assert client.post("/auth/setup", json={"token": new, "password": NEW_PASSWORD}).status_code == 200


def test_the_database_keeps_one_open_link_per_account(client, db, admin):
    account, _ = invite(client, admin)
    with pytest.raises(psycopg.errors.UniqueViolation):
        with db.transaction():
            db.execute("""INSERT INTO account_invite (user_id, token_sha256, expires_at)
                          VALUES (%s, repeat('a', 64), now() + interval '1 hour')""", (account["user_id"],))
    with pytest.raises(psycopg.errors.CheckViolation):      # a plain token can't be stored by mistake
        with db.transaction():
            db.execute("""INSERT INTO account_invite (user_id, token_sha256, expires_at, revoked_at)
                          VALUES (%s, 'plain-token', now() + interval '1 hour', now())""", (account["user_id"],))


def test_a_set_up_account_gets_no_new_link(client, admin):
    account, token = invite(client, admin)
    client.post("/auth/setup", json={"token": token, "password": NEW_PASSWORD})
    r = client.post(f"/admin/users/{account['user_id']}/invite", headers=admin)
    assert r.status_code == 409
    assert client.post("/admin/users/0/invite", headers=admin).status_code == 404


def test_the_invitation_email(client, admin, monkeypatch):
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            assert (host, port) == ("mail.test", 1025)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def send_message(self, msg):
            sent.append(msg)

    monkeypatch.setenv("SMTP_HOST", "mail.test")
    monkeypatch.setenv("SMTP_PORT", "1025")
    monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)
    account, token = invite(client, admin, display_name="<b>Jo</b> Lee")
    assert account["invite"]["emailed"] is True
    (msg,) = sent
    assert msg["To"] == f'"<b>Jo</b> Lee" <{NEW}>'
    text = msg.get_body(("plain",)).get_content()
    page = msg.get_body(("html",)).get_content()
    assert account["invite"]["link"] in text and token in page
    assert "Hi &lt;b&gt;Jo&lt;/b&gt;," in page and "<b>Jo" not in page    # the name is escaped
    assert "expires in 48 hours" in text


def test_a_failed_email_still_creates_the_account(client, db, admin, monkeypatch):
    def refuse(*_args, **_kw):
        raise ConnectionRefusedError("no mail server")

    monkeypatch.setenv("SMTP_HOST", "mail.test")
    monkeypatch.setattr(mailer.smtplib, "SMTP", refuse)
    account, _ = invite(client, admin)
    assert account["invite"]["emailed"] is False and accounts_named(db, NEW) == 1


# --- refused invitations ---------------------------------------------------------

def test_an_email_in_use_is_refused_in_any_case(client, db, admin):
    invite(client, admin)
    r = client.post("/admin/users", headers=admin, json=new_user(email="NEW@test.local", role="admin"))
    assert r.status_code == 409 and "already has an account" in r.json()["detail"]
    assert accounts_named(db, NEW) == 1


def test_the_default_accounts_are_left_to_the_loader(db):
    assert users.RESERVED_EMAILS == {email for email, *_ in seed_users.ACCOUNTS}
    for email in seed_users.ACCOUNTS[0][0].upper(), *users.RESERVED_EMAILS:
        before = accounts_named(db, email)
        with pytest.raises(users.EmailTaken, match="managed from .env"):
            users.create_user(db, email, "Imposter", "analyst")
        assert accounts_named(db, email) == before


def test_an_unknown_role_leaves_no_user_without_a_role(client, db, admin):
    assert client.post("/admin/users", headers=admin, json=new_user(role="superuser")).status_code == 422
    with pytest.raises(ValueError, match="unknown role"):
        users.create_user(db, NEW, "New", "superuser")       # past the route's check
    assert accounts_named(db, NEW) == 0                       # the user insert rolled back


@pytest.mark.parametrize("body", [new_user(email="not-an-email"), new_user(display_name="  "),
                                  {**new_user(), "password": PASSWORD},     # admins don't set passwords
                                  {**new_user(), "is_active": False}])
def test_invalid_requests_are_refused(client, db, admin, body):
    assert client.post("/admin/users", headers=admin, json=body).status_code == 422
    assert accounts_named(db, NEW) == 0


# --- disabling and enabling -------------------------------------------------------

def save_plan(db, owner: int) -> None:
    db.execute("INSERT INTO allocation_plan (owner_user_id, name) VALUES (%s, 'Kept')", (owner,))


def save_view(views, owner: int) -> None:
    now = datetime.now(timezone.utc)
    views.insert_one({"ownerUserId": owner, "name": "Kept", "page": "dashboard",
                      "filters": {}, "createdAt": now, "updatedAt": now})


def test_a_disabled_user_cannot_log_in_but_keeps_their_work(client, db, views, admin, make_user):
    user_id = make_user("worker@test.local", "analyst")
    save_plan(db, user_id)
    save_view(views, user_id)
    theirs = login(client, "worker@test.local")

    r = client.patch(f"/admin/users/{user_id}", headers=admin, json={"is_active": False})
    assert r.status_code == 200 and r.json()["status"] == "disabled" and r.json()["plans"] == 1
    assert client.get("/auth/me", headers=theirs).status_code == 401    # their session ends at once
    assert not can_log_in(client, "worker@test.local", PASSWORD)
    assert views.count_documents({"ownerUserId": user_id}) == 1

    r = client.patch(f"/admin/users/{user_id}", headers=admin, json={"is_active": True})
    assert r.json()["status"] == "active"
    assert can_log_in(client, "worker@test.local", PASSWORD)


def test_disabling_an_invited_account_revokes_its_link(client, admin):
    account, token = invite(client, admin)
    client.patch(f"/admin/users/{account['user_id']}", headers=admin, json={"is_active": False})
    client.patch(f"/admin/users/{account['user_id']}", headers=admin, json={"is_active": True})
    assert status_of(client, admin, NEW) == "invited"
    assert client.post("/auth/setup", json={"token": token, "password": NEW_PASSWORD}).status_code == 404


def test_an_admin_cannot_disable_themselves(client, make_user):
    me = make_user("boss@test.local", "admin")
    make_user("second@test.local", "admin")     # so the last-admin rule isn't what stops it
    headers = login(client, "boss@test.local")
    r = client.patch(f"/admin/users/{me}", headers=headers, json={"is_active": False})
    assert r.status_code == 409 and "your own account" in r.json()["detail"]
    assert client.get("/auth/me", headers=headers).status_code == 200
    assert client.patch("/admin/users/0", headers=headers, json={"is_active": False}).status_code == 404


def test_the_last_admin_who_can_log_in_cannot_be_disabled(db, make_user):
    only = make_user("boss@test.local", "admin")
    make_user("former@test.local", "admin", active=False)
    users.create_user(db, "invited-admin@test.local", "Invited", "admin")   # can't log in yet
    try:
        with pytest.raises(users.LastAdmin):
            users.set_active(db, only, False)
        make_user("second@test.local", "admin")
        assert users.set_active(db, only, False)["status"] == "disabled"
    finally:
        db.execute("DELETE FROM app_user WHERE email = 'invited-admin@test.local'")


def test_two_admins_disabling_each_other_at_once_leave_one(make_user):
    """Each thread has its own connection, and both start together. The admin
    rows are locked, so the second sees the first one's result."""
    a, b = make_user("a@test.local", "admin"), make_user("b@test.local", "admin")
    start, outcome = threading.Barrier(2), {}

    def disable(target):
        with pg_connect(autocommit=True) as conn:
            start.wait()
            try:
                users.set_active(conn, target, False)
                outcome[target] = "disabled"
            except users.LastAdmin:
                outcome[target] = "refused"

    threads = [threading.Thread(target=disable, args=(t,)) for t in (a, b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert sorted(outcome.values()) == ["disabled", "refused"]


def test_two_tabs_using_one_link_at_once_set_one_password(client, admin):
    _, token = invite(client, admin)
    start, outcome = threading.Barrier(2), []

    def use(password):
        with pg_connect(autocommit=True) as conn:
            start.wait()
            try:
                users.accept_invite(conn, token, password)
                outcome.append(password)
            except users.InvalidInvite:
                outcome.append("refused")

    threads = [threading.Thread(target=use, args=(p,)) for p in ("first-password-123", "second-password-123")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert outcome.count("refused") == 1
    (winner,) = [p for p in outcome if p != "refused"]
    assert can_log_in(client, NEW, winner)
