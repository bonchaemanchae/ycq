"""Saved Views routes (owner-only CRUD). TODO (Caleb): add create, rename, delete.

Served at /views/... here and at /api/views/... from the website. Views live
in MongoDB (saved_analysis_views); the validator and indexes are created by
etl/load_mongo.py. The save and open buttons go on the Activity Dashboard and
Flow Explorer pages.
"""
from fastapi import APIRouter, Depends

from ..auth import User, current_user
from ..db import mongo

router = APIRouter(prefix="/views", tags=["saved views"])


@router.get("")
def list_views(user: User = Depends(current_user)):
    """The caller's own saved views, newest first."""
    docs = mongo()["saved_analysis_views"].find(
        {"ownerUserId": user.user_id}).sort("updatedAt", -1)
    return [{**d, "_id": str(d["_id"])} for d in docs]
