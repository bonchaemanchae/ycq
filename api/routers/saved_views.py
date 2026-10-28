"""Saved Views routes (owner-only CRUD). The logic lives in api/saved_views.py.

Served at /views/... here and at /api/views/... from the website. Views live
in MongoDB (saved_analysis_views); the validator and indexes are created by
etl/load_mongo.py. The Activity Dashboard and Flow Explorer use them through
their "Saved views" panel (web/src/components/SavedViews.tsx).

  GET    /views?page=dashboard   your views, newest first (optionally one page's)
  POST   /views                  save {name, page, filters, widgets}
  GET    /views/{id}             one view
  PATCH  /views/{id}             rename, or store new filters or widgets
  DELETE /views/{id}
"""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException

from .. import saved_views as views
from ..auth import User, current_user
from ..db import get_pg, mongo

router = APIRouter(prefix="/views", tags=["saved views"])


def _coll():
    return mongo()[views.COLLECTION]


def _http(e: Exception) -> HTTPException:
    if isinstance(e, views.ViewNotFound):
        return HTTPException(404, str(e))
    if isinstance(e, views.ViewNameTaken):
        return HTTPException(409, str(e))
    return HTTPException(422, str(e))


@router.get("")
def list_views(page: Literal["dashboard", "flows"] | None = None, user: User = Depends(current_user)):
    """The caller's own saved views, newest first."""
    return views.list_views(_coll(), user.user_id, page)


@router.post("", status_code=201)
def create_view(body: views.ViewCreate, conn=Depends(get_pg), user: User = Depends(current_user)):
    try:
        return views.create_view(_coll(), conn, user.user_id, body)
    except views.ViewError as e:
        raise _http(e)


@router.get("/{view_id}")
def get_view(view_id: str, user: User = Depends(current_user)):
    try:
        return views.get_view(_coll(), user.user_id, view_id)
    except views.ViewNotFound as e:
        raise _http(e)


@router.patch("/{view_id}")
def update_view(view_id: str, body: views.ViewUpdate, conn=Depends(get_pg),
                user: User = Depends(current_user)):
    try:
        return views.update_view(_coll(), conn, user.user_id, view_id, body)
    except (views.ViewError, views.ViewNotFound) as e:
        raise _http(e)


@router.delete("/{view_id}", status_code=204)
def delete_view(view_id: str, user: User = Depends(current_user)):
    try:
        views.delete_view(_coll(), user.user_id, view_id)
    except views.ViewNotFound as e:
        raise _http(e)
