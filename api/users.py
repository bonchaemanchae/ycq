"""Accounts: inviting, setting up, disabling and enabling (sql/003, sql/019).

Admins never choose or see a password. They create an account with an email,
a name and one role, and the app makes a one-time link; the new user opens
it and sets their own password. Until then the account is "invited": its
password_hash is NULL, so no password can log in to it.

The link carries a random token. Only its SHA-256 hash is stored, so the
table can't be turned back into working links. A link works once, expires
after INVITE_HOURS, and is revoked when a newer link replaces it or the
account is disabled; at most one link per account is open at a time (a
partial unique index enforces it).

Accounts are disabled, not deleted. A disabled user can't log in and every
token they hold stops working at once (auth.current_user only accepts active
users), but their saved plans and saved views are kept, and an admin can
enable the account again. The app always keeps one admin who can log in.

The three default accounts are left to scripts/seed_users.py: the loader
sets their passwords and roles from .env on every start, so they can't be
invited here.
"""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

from .passwords import hash_password, password_problem

log = logging.getLogger("ycq.users")

INVITE_HOURS = 48

# The accounts scripts/seed_users.py manages from .env.
RESERVED_EMAILS = {"admin@ycq.local", "analyst1@ycq.local", "analyst2@ycq.local"}


class UserNotFound(LookupError):
    pass


class EmailTaken(ValueError):
    """Another account has this email (in any case), or it is a default account."""


class LastAdmin(ValueError):
    """Disabling this user would leave no admin who can log in."""


class NotInvited(ValueError):
    """A new link only makes sense for an active account that isn't set up yet."""


class InvalidInvite(LookupError):
    """The link is unknown, used, replaced, expired, or its account is disabled.
    One error for all of them, so the setup page doesn't reveal which."""


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# Every account with its role, status, plan count and open link's expiry.
_ACCOUNTS = """
    SELECT u.user_id, u.email, u.display_name, u.is_active, u.created_at,
           CASE WHEN NOT u.is_active THEN 'disabled'
                WHEN u.password_hash IS NULL THEN 'invited'
                ELSE 'active' END AS status,
           array_remove(array_agg(r.name ORDER BY r.name), NULL) AS roles,
           (SELECT count(*)::int FROM allocation_plan p WHERE p.owner_user_id = u.user_id) AS plans,
           (SELECT i.expires_at FROM account_invite i
            WHERE i.user_id = u.user_id AND i.used_at IS NULL AND i.revoked_at IS NULL) AS invite_expires_at
    FROM app_user u
    LEFT JOIN app_user_role ur USING (user_id)
    LEFT JOIN app_role r USING (role_id)
    {where}
    GROUP BY u.user_id
    ORDER BY u.user_id"""


def list_users(conn) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(_ACCOUNTS.format(where="")).fetchall()


def get_user(conn, user_id: int) -> dict:
    with conn.cursor(row_factory=dict_row) as cur:
        row = cur.execute(_ACCOUNTS.format(where="WHERE u.user_id = %s"), (user_id,)).fetchone()
    if row is None:
        raise UserNotFound(f"user {user_id} not found")
    return row


def _open_invite(conn, user_id: int, created_by: int | None) -> tuple[str, datetime]:
    """Revoke the account's open link, if any, and make a new one. Inside the
    caller's transaction. Returns the token (never stored) and its expiry."""
    conn.execute("""UPDATE account_invite SET revoked_at = now()
                    WHERE user_id = %s AND used_at IS NULL AND revoked_at IS NULL""", (user_id,))
    token = secrets.token_urlsafe(32)
    (expires_at,) = conn.execute(
        """INSERT INTO account_invite (user_id, token_sha256, created_by, expires_at)
           VALUES (%s, %s, %s, now() + make_interval(hours => %s))
           RETURNING expires_at""",
        (user_id, token_hash(token), created_by, INVITE_HOURS)).fetchone()
    return token, expires_at


def create_user(conn, email: str, display_name: str, role: str,
                created_by: int | None = None) -> tuple[dict, str, datetime]:
    """Create an invited account with one role and its first link, in one
    transaction. Returns the account, the link's token and its expiry.
    Raises EmailTaken, or ValueError for an unknown role; nothing is written
    in either case."""
    email = email.strip().lower()
    if email in RESERVED_EMAILS:
        raise EmailTaken(f"{email} is a default account and is managed from .env")
    try:
        with conn.transaction():
            (user_id,) = conn.execute(
                """INSERT INTO app_user (email, display_name, password_hash)
                   VALUES (%s, %s, NULL) RETURNING user_id""",
                (email, display_name.strip())).fetchone()
            if conn.execute("""INSERT INTO app_user_role (user_id, role_id)
                               SELECT %s, role_id FROM app_role WHERE name = %s""",
                            (user_id, role)).rowcount != 1:
                raise ValueError(f"unknown role {role!r}")   # rolls the user back too
            token, expires_at = _open_invite(conn, user_id, created_by)
    except psycopg.errors.UniqueViolation as e:
        raise EmailTaken(f"{email} already has an account") from e
    log.info("invited user %s (%s)", user_id, role)
    return get_user(conn, user_id), token, expires_at


def new_invite(conn, user_id: int, created_by: int | None = None) -> tuple[dict, str, datetime]:
    """A fresh link for an account that hasn't been set up; the old link stops
    working. Raises UserNotFound or NotInvited."""
    with conn.transaction():
        row = conn.execute("SELECT is_active, password_hash IS NULL FROM app_user WHERE user_id = %s FOR UPDATE",
                           (user_id,)).fetchone()
        if row is None:
            raise UserNotFound(f"user {user_id} not found")
        if not (row[0] and row[1]):
            raise NotInvited("only an invited account that hasn't been set up can get a new link")
        token, expires_at = _open_invite(conn, user_id, created_by)
    return get_user(conn, user_id), token, expires_at


def set_active(conn, user_id: int, active: bool) -> dict:
    """Disable or enable an account. Disabling revokes any open link and is
    refused for the last admin who can log in. Raises UserNotFound or LastAdmin."""
    with conn.transaction():
        if not active:
            # Lock every admin who can log in, in id order, so two admins
            # disabling each other at once take turns and one always remains.
            admins = [uid for (uid,) in conn.execute(
                """SELECT u.user_id FROM app_user u
                   JOIN app_user_role USING (user_id) JOIN app_role r USING (role_id)
                   WHERE r.name = 'admin' AND u.is_active AND u.password_hash IS NOT NULL
                   ORDER BY u.user_id
                   FOR UPDATE OF u""")]
            if admins == [user_id]:
                raise LastAdmin("this is the only admin who can log in")
            conn.execute("""UPDATE account_invite SET revoked_at = now()
                            WHERE user_id = %s AND used_at IS NULL AND revoked_at IS NULL""", (user_id,))
        if conn.execute("UPDATE app_user SET is_active = %s WHERE user_id = %s RETURNING 1",
                        (active, user_id)).fetchone() is None:
            raise UserNotFound(f"user {user_id} not found")
    log.info("user %s %s", user_id, "enabled" if active else "disabled")
    return get_user(conn, user_id)


_OPEN_LINK = """
    SELECT i.account_invite_id, u.user_id, u.email, u.display_name, i.expires_at
    FROM account_invite i JOIN app_user u USING (user_id)
    WHERE i.token_sha256 = %s AND i.used_at IS NULL AND i.revoked_at IS NULL
      AND i.expires_at > now() AND u.is_active AND u.password_hash IS NULL"""


def invite_details(conn, token: str) -> dict:
    """Who a link is for, so the setup page can greet them. Raises InvalidInvite."""
    with conn.cursor(row_factory=dict_row) as cur:
        row = cur.execute(_OPEN_LINK, (token_hash(token),)).fetchone()
    if row is None:
        raise InvalidInvite("this link has expired or has already been used")
    return {"email": row["email"], "display_name": row["display_name"], "expires_at": row["expires_at"]}


def accept_invite(conn, token: str, password: str) -> int:
    """Set the account's password from a link and use the link up. Returns
    the user id. Raises ValueError for a refused password (the link stays
    usable) or InvalidInvite."""
    if problem := password_problem(password):
        raise ValueError(f"the password {problem}")
    password_hash = hash_password(password)   # outside the transaction: it takes ~50 ms
    with conn.transaction():
        # FOR UPDATE: two tabs submitting the same link at once take turns,
        # and the second finds it already used.
        row = conn.execute(_OPEN_LINK + " FOR UPDATE OF i, u", (token_hash(token),)).fetchone()
        if row is None:
            raise InvalidInvite("this link has expired or has already been used")
        invite_id, user_id = row[0], row[1]
        conn.execute("UPDATE app_user SET password_hash = %s WHERE user_id = %s", (password_hash, user_id))
        conn.execute("UPDATE account_invite SET used_at = now() WHERE account_invite_id = %s", (invite_id,))
    log.info("user %s set up their account", user_id)
    return user_id
