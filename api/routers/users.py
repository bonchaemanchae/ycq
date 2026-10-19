"""User administration (admin role only; applied in api/main.py).

Served at /admin/users/... here and at /api/admin/users/... from the website.
The logic, and why deletion runs in the order it does, is in api/users.py.
"""
from fastapi import APIRouter, Depends, HTTPException

from .. import users
from ..auth import User, current_user
from ..db import get_pg, mongo
from ..saved_views import COLLECTION as VIEWS

router = APIRouter(prefix="/admin/users", tags=["admin"])


@router.get("")
def list_users(conn=Depends(get_pg)):
    """Every account with its roles, whether it is active, and its plan count."""
    return users.list_users(conn)


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
