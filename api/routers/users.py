"""User administration (admin role only; applied in api/main.py).

Served at /admin/users/... here and at /api/admin/users/... from the website.
The logic, and why deletion runs in the order it does, is in api/users.py.
"""
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .. import users
from ..auth import User, current_user
from ..db import get_pg, mongo
from ..saved_views import COLLECTION as VIEWS

router = APIRouter(prefix="/admin/users", tags=["admin"])


class NewUser(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A plain pattern, not EmailStr: that needs another package and refuses
    # .local addresses such as the default accounts'.
    email: Annotated[str, StringConstraints(strip_whitespace=True, max_length=254,
                                            pattern=r"^[^@\s]+@[^@\s]+$")]
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                                   max_length=100)]
    role: Literal["analyst", "admin"]
    password: str = Field(max_length=1024)   # the rule itself is in api/passwords.py


@router.get("")
def list_users(conn=Depends(get_pg)):
    """Every account with its roles, whether it is active, and its plan count."""
    return users.list_users(conn)


@router.post("", status_code=201)
def create_user(body: NewUser, conn=Depends(get_pg)):
    """Create an analyst or admin account. 409 if the email is taken or is
    one of the default accounts from .env, 422 if the password is refused."""
    try:
        return users.create_user(conn, body.email, body.display_name, body.role, body.password)
    except users.EmailTaken as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.delete("/{user_id}")
def delete_user(user_id: int, conn=Depends(get_pg), me: User = Depends(current_user)):
    """Delete a user, their saved plans (PostgreSQL) and saved views (MongoDB)."""
    if user_id == me.user_id:
        raise HTTPException(409, "you can't delete your own account")
    try:
        return users.delete_user(conn, mongo()[VIEWS], user_id)
    except users.UserNotFound as e:
        raise HTTPException(404, str(e))
    except users.LastAdmin as e:
        raise HTTPException(409, str(e))
    except users.DeletionIncomplete as e:
        raise HTTPException(503, str(e))
