"""Create or update the default accounts from .env.

    python scripts/seed_users.py

Run by the loader (etl/load_all.py) on every start. Each account's password
comes from .env; an account whose variable is unset is skipped, so nobody can
log in with a password that wasn't chosen. Safe to run again: an existing
account keeps its id, plans and views, and its hash is only replaced when
the password in .env has changed.

The accounts follow .env: one deleted in the app is created again (empty) on
the next start while its password is still set. Remove the variable to keep
it deleted.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "etl"))

from api.passwords import hash_password, password_problem, verify_password  # noqa: E402
from common import pg_connect  # noqa: E402

# (email, display name, role, password variable)
ACCOUNTS = [
    ("admin@ycq.local", "Admin", "admin", "YCQ_ADMIN_PASSWORD"),
    ("analyst1@ycq.local", "Analyst One", "analyst", "YCQ_ANALYST1_PASSWORD"),
    ("analyst2@ycq.local", "Analyst Two", "analyst", "YCQ_ANALYST2_PASSWORD"),
]


def seed(conn, env=os.environ) -> dict[str, str]:
    """What happened to each account: created, password updated, unchanged
    or skipped. Checks every password before writing anything."""
    passwords = {var: env.get(var, "") for *_, var in ACCOUNTS}
    for var, password in passwords.items():
        if password and (problem := password_problem(password)):
            raise ValueError(f"{var} {problem}")

    result = {}
    with conn.transaction():
        for email, name, role, var in ACCOUNTS:
            password = passwords[var]
            if not password:
                result[email] = f"skipped ({var} not set)"
                continue
            row = conn.execute("SELECT user_id, password_hash FROM app_user WHERE lower(email) = %s",
                               (email,)).fetchone()
            if row is None:
                (user_id,) = conn.execute(
                    """INSERT INTO app_user (email, display_name, password_hash)
                       VALUES (%s, %s, %s) RETURNING user_id""",
                    (email, name, hash_password(password))).fetchone()
                result[email] = "created"
            elif not verify_password(row[1], password):
                user_id = row[0]
                conn.execute("UPDATE app_user SET password_hash = %s WHERE user_id = %s",
                             (hash_password(password), user_id))
                result[email] = "password updated"
            else:
                user_id = row[0]
                result[email] = "unchanged"
            conn.execute(
                """INSERT INTO app_user_role (user_id, role_id)
                   SELECT %s, role_id FROM app_role WHERE name = %s
                   ON CONFLICT DO NOTHING""",
                (user_id, role))
    return result


def main() -> None:
    with pg_connect(autocommit=True) as conn:
        try:
            result = seed(conn)
        except ValueError as e:
            sys.exit(f"seed_users: {e}")
    for email, what in result.items():
        print(f"  {email}: {what}")


if __name__ == "__main__":
    main()
