"""Flow Explorer routes. The logic lives in api/flows.py.

Served at /flows/... here and at /api/flows/... from the website. Query
parameters are camelCase, like the MongoDB fields they filter on.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from .. import flows
from ..auth import current_user
from ..db import mongo

# Logged-in users only, once login replaces the dev user.
router = APIRouter(prefix="/flows", tags=["flows"], dependencies=[Depends(current_user)])


def _coll():
    return mongo()[flows.COLLECTION]


@router.get("")
def flow_slice(q: Annotated[flows.SliceQuery, Query()]):
    """Top 10 destinations from one zone for a month, day type and time bucket."""
    return flows.get_slice(_coll(), q)


@router.get("/months")
def months():
    """Months that have flow snapshots, oldest first."""
    return flows.loaded_months(_coll())


@router.get("/compare-months")
def compare_months(q: Annotated[flows.CompareQuery, Query()]):
    """One zone, day type and time bucket across every loaded month (each
    month's top 10 only)."""
    return flows.compare_months(_coll(), q)
