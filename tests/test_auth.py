"""Login and roles: password hashes, tokens, the login route, the default
accounts, and which routes each kind of user may call.

The route checks call every registered route, so a route added later without
the right protection fails here.
"""
import base64
import json
import sys
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from argon2 import PasswordHasher
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from conftest import JWT_TEST_SECRET, PASSWORD, ROOT, login

sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import seed_users  # noqa: E402
from api import auth  # noqa: E402
from api.main import app  # noqa: E402
from api.passwords import hash_password, verify_password  # noqa: E402

PUBLIC_PATHS = {"/health", "/auth/login"}
ANY_USER_PATHS = {"/auth/me"}          # logged in, no particular role


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", JWT_TEST_SECRET)


# --- passwords and tokens ------------------------------------------------------

def test_hash_is_argon2id_with_the_rfc_9106_profile():
    h = hash_password(PASSWORD)
    assert h.startswith("$argon2id$v=19$m=65536,t=3,p=4$")
    assert verify_password(h, PASSWORD)
    assert not verify_password(h, PASSWORD + "!")
    assert h != hash_password(PASSWORD)          # salted


def test_a_value_that_is_not_a_hash_never_verifies():
    assert not verify_password("disabled", "disabled")   # the old dev user's
    assert not verify_password("", "")


@pytest.mark.parametrize("value", [None, "", "change-me", "x" * 31])
def test_weak_jwt_secret_is_refused(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("JWT_SECRET")
    else:
        monkeypatch.setenv("JWT_SECRET", value)
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        auth.jwt_secret()


def test_api_does_not_start_with_a_weak_secret(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "change-me")
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        with TestClient(app):
            pass


def test_token_round_trip_and_lifetime():
    token = auth.create_token(42)
    assert auth.token_user_id(token) == 42
    claims = jwt.decode(token, JWT_TEST_SECRET, algorithms=["HS256"])
    assert set(claims) == {"sub", "iat", "exp"}            # no roles in the token
    assert claims["exp"] - claims["iat"] == 8 * 3600


def _encode(claims, key=JWT_TEST_SECRET, algorithm="HS256"):
    return jwt.encode(claims, key, algorithm=algorithm)


def _altered(token):
    """The token with its payload changed to user 2 and the old signature kept."""
    head, payload, sig = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims["sub"] = "2"
    forged = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"{head}.{forged}.{sig}"


NOW = datetime.now(timezone.utc)
BAD_TOKENS = {
    "expired": lambda: _encode({"sub": "1", "iat": NOW - timedelta(hours=9),
                                "exp": NOW - timedelta(hours=1)}),
    "other secret": lambda: _encode({"sub": "1", "iat": NOW, "exp": NOW + timedelta(hours=1)},
                                    key="another-secret-" + "y" * 32),
    "alg none": lambda: _encode({"sub": "1", "iat": NOW, "exp": NOW + timedelta(hours=1)},
                                key=None, algorithm="none"),
    "no sub": lambda: _encode({"iat": NOW, "exp": NOW + timedelta(hours=1)}),
    "no exp": lambda: _encode({"sub": "1", "iat": NOW}),
    "sub not a number": lambda: _encode({"sub": "admin", "iat": NOW,
                                         "exp": NOW + timedelta(hours=1)}),
    "altered payload": lambda: _altered(auth.create_token(1)),
    "not a token": lambda: "abc.def.ghi",
}


@pytest.mark.parametrize("kind", BAD_TOKENS)
def test_bad_tokens_are_rejected(kind):
    assert auth.token_user_id(BAD_TOKENS[kind]()) is None


# --- login ---------------------------------------------------------------------

def test_login_returns_a_working_token(client, make_user):
    make_user("ana@test.local", "analyst")
    r = client.post("/auth/login", json={"email": "  ANA@Test.local ", "password": PASSWORD})
    assert r.status_code == 200
    assert r.json()["user"]["roles"] == ["analyst"]
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {r.json()['token']}"})
    assert me.status_code == 200 and me.json()["email"] == "ana@test.local"


def test_every_login_failure_looks_the_same(client, make_user):
    make_user("ana@test.local", "analyst")
    make_user("gone@test.local", "analyst", active=False)
    answers = [client.post("/auth/login", json={"email": email, "password": password})
               for email, password in [("ana@test.local", "wrong password"),
                                       ("nobody@test.local", PASSWORD),
                                       ("gone@test.local", PASSWORD)]]
    assert {(r.status_code, r.json()["detail"]) for r in answers} == {(401, "wrong email or password")}


def test_login_upgrades_an_old_weaker_hash(client, db, make_user):
    user_id = make_user("ana@test.local", "analyst")
    weak = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1).hash(PASSWORD)
    db.execute("UPDATE app_user SET password_hash = %s WHERE user_id = %s", (weak, user_id))
    login(client, "ana@test.local")
    (stored,) = db.execute("SELECT password_hash FROM app_user WHERE user_id = %s",
                           (user_id,)).fetchone()
    assert stored.startswith("$argon2id$v=19$m=65536,t=3,p=4$")


def test_changes_to_a_user_apply_to_tokens_already_issued(client, db, make_user):
    user_id = make_user("boss@test.local", "admin")
    headers = login(client, "boss@test.local")
    assert client.get("/admin/imports", headers=headers).status_code == 200
    db.execute("DELETE FROM app_user_role WHERE user_id = %s", (user_id,))
    assert client.get("/admin/imports", headers=headers).status_code == 403
    db.execute("UPDATE app_user SET is_active = false WHERE user_id = %s", (user_id,))
    assert client.get("/auth/me", headers=headers).status_code == 401


# --- who may call which route --------------------------------------------------

def _calls():
    """(method, path) for every route; path ids are 0, which never exists, so
    no call changes data (bodies are missing, so writes stop at validation)."""
    for route in app.routes:
        if isinstance(route, APIRoute):
            path = route.path
            for name in route.param_convertors:
                path = path.replace("{" + name + "}", "0")
            for method in route.methods:
                yield method, route.path, path


def _expected(template, who):
    if template in PUBLIC_PATHS:
        return "allowed"
    if who == "nobody":
        return 401
    if template in ANY_USER_PATHS:
        return "allowed"
    if who == "no role":
        return 403
    if template.startswith("/admin") and who == "analyst":
        return 403
    return "allowed"


def test_every_route_has_the_right_protection(client, make_user):
    make_user("norole@test.local")
    make_user("ana@test.local", "analyst")
    make_user("boss@test.local", "admin")
    people = {"nobody": {},
              "no role": login(client, "norole@test.local"),
              "analyst": login(client, "ana@test.local"),
              "admin": login(client, "boss@test.local")}
    wrong = []
    for method, template, path in _calls():
        for who, headers in people.items():
            status = client.request(method, path, headers=headers).status_code
            expected = _expected(template, who)
            ok = status not in (401, 403) if expected == "allowed" else status == expected
            if not ok:
                wrong.append(f"{who} {method} {template}: got {status}, expected {expected}")
    assert not wrong, "\n".join(wrong)


def test_missing_or_malformed_header_is_401(client):
    for headers in ({}, {"Authorization": "Bearer"}, {"Authorization": "Basic abc"},
                    {"Authorization": "Bearer not-a-token"}):
        r = client.get("/plans", headers=headers)
        assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"


# --- default accounts (scripts/seed_users.py) ----------------------------------

SEED_EMAILS = [email for email, *_ in seed_users.ACCOUNTS]
SEED_ENV = {"YCQ_ADMIN_PASSWORD": "admin password 1",
            "YCQ_ANALYST1_PASSWORD": "analyst password 1",
            "YCQ_ANALYST2_PASSWORD": "analyst password 2"}


@pytest.fixture
def seeded(db):
    def accounts():
        return db.execute(
            """SELECT u.email, u.user_id, u.password_hash, array_agg(r.name ORDER BY r.name)
               FROM app_user u JOIN app_user_role USING (user_id) JOIN app_role r USING (role_id)
               WHERE u.email = ANY(%s) GROUP BY 1, 2, 3 ORDER BY 1""", (SEED_EMAILS,)).fetchall()
    db.execute("DELETE FROM app_user WHERE email = ANY(%s)", (SEED_EMAILS,))
    yield accounts
    db.execute("DELETE FROM app_user WHERE email = ANY(%s)", (SEED_EMAILS,))


def test_seed_creates_the_accounts_and_running_again_changes_nothing(db, seeded):
    assert set(seed_users.seed(db, SEED_ENV).values()) == {"created"}
    first = seeded()
    assert [(email, roles) for email, _, _, roles in first] == [
        ("admin@ycq.local", ["admin"]), ("analyst1@ycq.local", ["analyst"]),
        ("analyst2@ycq.local", ["analyst"])]
    for (email, _, stored, _), password in zip(first, SEED_ENV.values()):
        assert stored.startswith("$argon2id$") and verify_password(stored, password)

    assert set(seed_users.seed(db, SEED_ENV).values()) == {"unchanged"}
    assert seeded() == first                     # same ids, same hashes, no duplicates


def test_seed_follows_a_changed_password(db, seeded):
    seed_users.seed(db, SEED_ENV)
    before = seeded()
    changed = {**SEED_ENV, "YCQ_ADMIN_PASSWORD": "a new admin password"}
    assert seed_users.seed(db, changed)["admin@ycq.local"] == "password updated"
    after = seeded()
    assert after[0][1] == before[0][1]           # same account
    assert verify_password(after[0][2], "a new admin password")
    assert after[1:] == before[1:]


def test_seed_skips_an_unset_password(db, seeded):
    result = seed_users.seed(db, {**SEED_ENV, "YCQ_ANALYST2_PASSWORD": ""})
    assert result["analyst2@ycq.local"].startswith("skipped")
    assert [row[0] for row in seeded()] == ["admin@ycq.local", "analyst1@ycq.local"]


@pytest.mark.parametrize("password", ["short", "change-me", "change-me-please-123"])
def test_seed_refuses_a_weak_password_before_writing_anything(db, seeded, password):
    with pytest.raises(ValueError, match="YCQ_ANALYST2_PASSWORD"):
        seed_users.seed(db, {**SEED_ENV, "YCQ_ANALYST2_PASSWORD": password})
    assert seeded() == []
