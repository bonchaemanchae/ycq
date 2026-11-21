"""User management (admin role only; applied in api/main.py).

Served at /admin/users/... here and at /api/admin/users/... from the website.
The logic is in api/users.py, the invitation email in api/mailer.py.
"""
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, StringConstraints

from .. import mailer, users
from ..auth import User, current_user
from ..db import get_pg

router = APIRouter(prefix="/admin/users", tags=["admin"])


class NewUser(BaseModel):
    model_config = ConfigDict(extra="forbid")   # a password here is refused: users set their own

    # A plain pattern, not EmailStr: that needs another package and refuses
    # .local addresses such as the default accounts'.
    email: Annotated[str, StringConstraints(strip_whitespace=True, max_length=254,
                                            pattern=r"^[^@\s]+@[^@\s]+$")]
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                                   max_length=100)]
    role: Literal["analyst", "admin"]


class Status(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_active: bool


def _invited(account: dict, token: str, expires_at: datetime, me: User) -> dict:
    """The account, plus its new link and whether the email went out. The link
    is only ever shown here: the database keeps just its hash."""
    link = mailer.invite_link(token)
    emailed = mailer.send_invite(account["email"], account["display_name"], account["roles"][0],
                                 link, expires_at, me.display_name or me.email)
    return {**account, "invite": {"link": link, "expires_at": expires_at, "emailed": emailed,
                                  "inbox_url": mailer.inbox_url()}}


@router.get("")
def list_users(conn=Depends(get_pg)):
    """Every account with its role, status (active, invited or disabled),
    plan count and, while invited, when its link expires."""
    return users.list_users(conn)


@router.post("", status_code=201)
def invite_user(body: NewUser, conn=Depends(get_pg), me: User = Depends(current_user)):
    """Create an invited account and email its one-time setup link. 409 if
    the email is taken or is one of the default accounts from .env."""
    try:
        account, token, expires_at = users.create_user(conn, body.email, body.display_name, body.role,
                                                       me.user_id)
    except users.EmailTaken as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _invited(account, token, expires_at, me)


@router.post("/{user_id}/invite")
def resend_invite(user_id: int, conn=Depends(get_pg), me: User = Depends(current_user)):
    """A new setup link for an invited account; the old one stops working."""
    try:
        account, token, expires_at = users.new_invite(conn, user_id, me.user_id)
    except users.UserNotFound as e:
        raise HTTPException(404, str(e))
    except users.NotInvited as e:
        raise HTTPException(409, str(e))
    return _invited(account, token, expires_at, me)


@router.patch("/{user_id}")
def set_status(user_id: int, body: Status, conn=Depends(get_pg), me: User = Depends(current_user)):
    """Disable or enable an account. Disabled users can't log in; their plans
    and saved views are kept."""
    if user_id == me.user_id and not body.is_active:
        raise HTTPException(409, "you can't disable your own account")
    try:
        return users.set_active(conn, user_id, body.is_active)
    except users.UserNotFound as e:
        raise HTTPException(404, str(e))
    except users.LastAdmin as e:
        raise HTTPException(409, str(e))
