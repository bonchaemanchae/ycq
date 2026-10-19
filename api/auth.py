"""Who is calling: login tokens and role checks.

POST /auth/login checks the password and returns a JWT signed with
JWT_SECRET (HS256, valid 8 hours). The token only says who the user is
(`sub` = user_id). Every request loads the user and their roles from
PostgreSQL again, so deactivating or deleting a user, or removing a role,
takes effect on their very next request, without a token blacklist.

Routes depend on `current_user` (any logged-in user) or on
`require_role(...)`; api/main.py applies them per router.
"""
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .db import get_pg
from .passwords import hash_password, needs_rehash, verify_password

TOKEN_HOURS = 8
ALGORITHM = "HS256"
MIN_SECRET_LENGTH = 32

# Verified when the email is unknown, so a wrong email takes as long as a
# wrong password and response times don't reveal which accounts exist.
_DUMMY_HASH = hash_password("no such user")

# auto_error=False: a missing token becomes our 401, not FastAPI's 403.
_bearer = HTTPBearer(auto_error=False)


@dataclass
class User:
    user_id: int
    email: str
    roles: list[str]
    display_name: str = ""


def jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET", "")
    if len(secret) < MIN_SECRET_LENGTH:
        # A short or example secret (change-me) would let anyone forge an
        # admin token, so the API refuses to start with one.
        raise RuntimeError(
            f"JWT_SECRET must be a random value of at least {MIN_SECRET_LENGTH} characters. "
            "Set it in .env, for example with: "
            "python -c \"import secrets; print(secrets.token_hex(32))\"")
    return secret


def create_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    claims = {"sub": str(user_id), "iat": now, "exp": now + timedelta(hours=TOKEN_HOURS)}
    return jwt.encode(claims, jwt_secret(), algorithm=ALGORITHM)


def token_user_id(token: str) -> int | None:
    """The user id in a valid token; None if it is expired, altered, signed
    with another secret or algorithm, or missing a claim."""
    try:
        claims = jwt.decode(token, jwt_secret(), algorithms=[ALGORITHM],
                            options={"require": ["sub", "iat", "exp"]})
        return int(claims["sub"])
    except (jwt.InvalidTokenError, ValueError):
        return None


def _find_active(conn, where: str, value) -> tuple[User, str] | None:
    """An active user and their password hash. `where` is one of the fixed
    conditions below, never user input."""
    row = conn.execute(
        f"""SELECT u.user_id, u.email, u.display_name, u.password_hash,
                   array_remove(array_agg(r.name ORDER BY r.name), NULL)
            FROM app_user u
            LEFT JOIN app_user_role ur USING (user_id)
            LEFT JOIN app_role r USING (role_id)
            WHERE u.is_active AND {where}
            GROUP BY u.user_id""",
        (value,),
    ).fetchone()
    if row is None:
        return None
    user_id, email, name, password_hash, roles = row
    return User(user_id, email, roles, name), password_hash


def login(conn, email: str, password: str) -> User | None:
    """The user if the email and password match an active account. The email
    is case-insensitive, like the unique index on app_user."""
    found = _find_active(conn, "lower(u.email) = lower(%s)", email.strip())
    if found is None:
        verify_password(_DUMMY_HASH, password)
        return None
    user, stored = found
    if not verify_password(stored, password):
        return None
    if needs_rehash(stored):
        conn.execute("UPDATE app_user SET password_hash = %s WHERE user_id = %s",
                     (hash_password(password), user.user_id))
    return user


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
                 conn=Depends(get_pg)) -> User:
    """FastAPI dependency: the logged-in, active user, or 401."""
    user_id = token_user_id(creds.credentials) if creds else None
    found = _find_active(conn, "u.user_id = %s", user_id) if user_id is not None else None
    if found is None:
        raise HTTPException(401, "not logged in, or the session has expired",
                            headers={"WWW-Authenticate": "Bearer"})
    return found[0]


def require_role(*roles: str):
    """FastAPI dependency: the logged-in user if they have any of `roles`,
    otherwise 403."""
    def check(user: User = Depends(current_user)) -> User:
        if not set(roles) & set(user.roles):
            raise HTTPException(403, f"needs the {' or '.join(roles)} role")
        return user
    return check


# Analysts and admins can use every feature; only admins the admin pages.
any_role = require_role("analyst", "admin")
admin_only = require_role("admin")
