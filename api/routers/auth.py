"""Login routes. Served at /auth/... here and at /api/auth/... from the website."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import auth
from ..auth import User, current_user
from ..db import get_pg

router = APIRouter(prefix="/auth", tags=["auth"])


class Login(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    # Capped so a huge password can't make each hash expensive.
    password: str = Field(min_length=1, max_length=1024)


@router.post("/login")
def login(body: Login, conn=Depends(get_pg)):
    """A token for the Authorization header (`Bearer <token>`), valid 8 hours."""
    user = auth.login(conn, body.email, body.password)
    if user is None:
        # One message for every failure, so it doesn't reveal which emails exist.
        raise HTTPException(401, "wrong email or password")
    return {"token": auth.create_token(user.user_id), "user": user}


@router.get("/me")
def me(user: User = Depends(current_user)) -> User:
    return user
