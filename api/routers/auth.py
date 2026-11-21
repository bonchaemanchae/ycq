"""Login and account setup routes, open to everyone.
Served at /auth/... here and at /api/auth/... from the website."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import auth, users
from ..auth import User, current_user
from ..db import get_pg

router = APIRouter(prefix="/auth", tags=["auth"])


class Login(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    # Capped so a huge password can't make each hash expensive.
    password: str = Field(min_length=1, max_length=1024)


class Invite(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class Setup(Invite):
    password: str = Field(min_length=1, max_length=1024)


def _session(conn, user_id: int) -> dict:
    return {"token": auth.create_token(user_id), "user": auth.active_user(conn, user_id)}


@router.post("/login")
def login(body: Login, conn=Depends(get_pg)):
    """A token for the Authorization header (`Bearer <token>`), valid 8 hours.
    401 for a wrong email or password, 403 for the right password on an
    account an admin has disabled."""
    try:
        user = auth.login(conn, body.email, body.password)
    except auth.AccountDisabled:
        raise HTTPException(403, "this account has been disabled, contact your administrator")
    if user is None:
        # One message for every failure, so it doesn't reveal which emails exist.
        raise HTTPException(401, "wrong email or password")
    return {"token": auth.create_token(user.user_id), "user": user}


@router.post("/invite")
def invite(body: Invite, conn=Depends(get_pg)):
    """Who a setup link is for. The token is sent in the body, not the URL,
    so it stays out of logs. 404 for any link that can't be used."""
    try:
        return users.invite_details(conn, body.token)
    except users.InvalidInvite as e:
        raise HTTPException(404, str(e))


@router.post("/setup")
def setup(body: Setup, conn=Depends(get_pg)):
    """Set a new account's password from its link and log in. 422 if the
    password is refused (the link still works), 404 if the link can't be used."""
    try:
        user_id = users.accept_invite(conn, body.token, body.password)
    except users.InvalidInvite as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _session(conn, user_id)


@router.get("/me")
def me(user: User = Depends(current_user)) -> User:
    return user
