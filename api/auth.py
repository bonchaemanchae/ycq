"""Who is calling. TEMPORARY until the real login (Argon2 + JWT) is built.

Every request is treated as the dev user `dev@ycq.local`, created on start-up.
The login work replaces `current_user` with one that reads the JWT; routes
already depend on it, so nothing else has to change.
"""
from dataclasses import dataclass

from fastapi import Depends

from .db import get_pg

DEV_EMAIL = "dev@ycq.local"


@dataclass
class User:
    user_id: int
    email: str
    roles: list[str]


def ensure_dev_user(conn) -> None:
    # 'disabled' is not an Argon2 hash, so nobody can log in as this user.
    with conn.transaction():
        conn.execute(
            """INSERT INTO app_user (email, display_name, password_hash)
               VALUES (%s, 'Dev user', 'disabled')
               ON CONFLICT ((lower(email))) DO NOTHING""",
            (DEV_EMAIL,),
        )
        conn.execute(
            """INSERT INTO app_user_role (user_id, role_id)
               SELECT u.user_id, r.role_id FROM app_user u, app_role r
               WHERE lower(u.email) = %s
               ON CONFLICT DO NOTHING""",
            (DEV_EMAIL,),
        )


def current_user(conn=Depends(get_pg)) -> User:
    user_id, email, roles = conn.execute(
        """SELECT u.user_id, u.email, array_remove(array_agg(r.name ORDER BY r.name), NULL)
           FROM app_user u
           LEFT JOIN app_user_role ur USING (user_id)
           LEFT JOIN app_role r USING (role_id)
           WHERE lower(u.email) = %s
           GROUP BY u.user_id""",
        (DEV_EMAIL,),
    ).fetchone()
    return User(user_id, email, roles)
