"""Listing, creating and deleting users. Deleting spans both databases.

Admins create accounts with exactly one role, written in one transaction, so
there is never a user without a role. The three default accounts are left to
scripts/seed_users.py: the loader resets their password and role from .env on
every start, so they can't be created here.

PostgreSQL's ON DELETE CASCADE removes a user's roles and saved plans (with
their versions and results), but it can't reach the user's saved views in
MongoDB, and the two databases share no transaction. So delete_user runs
three steps, ordered so that any failure leaves something to retry from:

  1. PostgreSQL: deactivate the user. Their login and every token they hold
     stop working at once (auth.current_user only accepts active users). A
     view being saved holds the user's row (saved_views.create_view), so
     this waits for it to be stored; after it, no new view can be saved.
     The last active admin is refused here, so the app always keeps one.
  2. MongoDB: delete their saved views.
  3. PostgreSQL: delete the user; the cascade removes roles and plans.

MongoDB goes before the user row on purpose: while the row exists, a failure
leaves an inactive user that the admin can simply delete again. The other
order would leave views whose owner no longer exists and that no endpoint can
reach.
"""
import logging

import psycopg
from psycopg.rows import dict_row
from pymongo.collection import Collection
from pymongo.errors import PyMongoError

from .passwords import hash_password, password_problem
from .saved_views import delete_views_for_user

log = logging.getLogger("ycq.users")

# The accounts scripts/seed_users.py manages from .env.
RESERVED_EMAILS = {"admin@ycq.local", "analyst1@ycq.local", "analyst2@ycq.local"}


class UserNotFound(LookupError):
    pass


class EmailTaken(ValueError):
    """Another account has this email (in any case), or it is a default account."""


class LastAdmin(ValueError):
    """Deleting this user would leave no active admin."""


class DeletionIncomplete(RuntimeError):
    """A step failed. The user is inactive and deleting again finishes the job."""


def list_users(conn) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            """SELECT u.user_id, u.email, u.display_name, u.is_active,
                      array_remove(array_agg(r.name ORDER BY r.name), NULL) AS roles,
                      (SELECT count(*)::int FROM allocation_plan p
                       WHERE p.owner_user_id = u.user_id) AS plans
               FROM app_user u
               LEFT JOIN app_user_role ur USING (user_id)
               LEFT JOIN app_role r USING (role_id)
               GROUP BY u.user_id
               ORDER BY u.user_id""").fetchall()


def create_user(conn, email: str, display_name: str, role: str, password: str) -> dict:
    """Create an active account with one role, shaped like a list_users row.
    Raises EmailTaken, or ValueError for a refused password or unknown role;
    nothing is written in either case."""
    email = email.strip().lower()
    if email in RESERVED_EMAILS:
        raise EmailTaken(f"{email} is a default account and is managed from .env")
    if problem := password_problem(password):
        raise ValueError(f"the password {problem}")
    password_hash = hash_password(password)   # outside the transaction: it takes ~50 ms
    try:
        with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
            user = cur.execute(
                """INSERT INTO app_user (email, display_name, password_hash)
                   VALUES (%s, %s, %s)
                   RETURNING user_id, email, display_name, is_active""",
                (email, display_name.strip(), password_hash)).fetchone()
            if cur.execute("""INSERT INTO app_user_role (user_id, role_id)
                              SELECT %s, role_id FROM app_role WHERE name = %s""",
                           (user["user_id"], role)).rowcount != 1:
                raise ValueError(f"unknown role {role!r}")   # rolls the user back too
    except psycopg.errors.UniqueViolation as e:
        raise EmailTaken(f"{email} already has an account") from e
    log.info("created user %s (%s)", user["user_id"], role)
    return {**user, "roles": [role], "plans": 0}


def delete_user(conn, views: Collection, user_id: int) -> dict:
    """Delete a user everywhere. Raises UserNotFound, LastAdmin, or
    DeletionIncomplete if a database fails part way (safe to call again)."""
    with conn.transaction():
        # Locking every active admin (in id order, so two deletions can't
        # deadlock) makes concurrent deletions take turns: two admins deleting
        # each other at once can't remove both.
        admins = [uid for (uid,) in conn.execute(
            """SELECT u.user_id FROM app_user u
               JOIN app_user_role USING (user_id) JOIN app_role r USING (role_id)
               WHERE r.name = 'admin' AND u.is_active
               ORDER BY u.user_id
               FOR UPDATE OF u""")]
        if admins == [user_id]:
            raise LastAdmin("this is the only active admin")
        if conn.execute("UPDATE app_user SET is_active = false WHERE user_id = %s RETURNING 1",
                        (user_id,)).fetchone() is None:
            raise UserNotFound(f"user {user_id} not found")
    log.info("deleting user %s: deactivated", user_id)

    try:
        deleted_views = delete_views_for_user(views, user_id)
    except PyMongoError as e:
        log.exception("deleting user %s: saved views could not be deleted", user_id)
        raise DeletionIncomplete(
            "The user is deactivated, but their saved views could not be deleted. Try again.") from e

    try:
        with conn.transaction():
            (deleted_plans,) = conn.execute(
                "SELECT count(*)::int FROM allocation_plan WHERE owner_user_id = %s",
                (user_id,)).fetchone()
            conn.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))
    except psycopg.Error as e:
        log.exception("deleting user %s: %s views deleted, but the user row could not be",
                      user_id, deleted_views)
        raise DeletionIncomplete(
            "Their saved views were deleted, but the user could not be. Try again.") from e

    log.info("deleted user %s: %s saved views, %s plans", user_id, deleted_views, deleted_plans)
    return {"user_id": user_id, "deleted_views": deleted_views, "deleted_plans": deleted_plans}
