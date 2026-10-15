"""Activity Dashboard routes. TODO (Kessler): replace the example.

Served at /dashboard/... here and at /api/dashboard/... from the website.
"""
from fastapi import APIRouter, Depends

from ..db import get_pg

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/example")
def example(conn=Depends(get_pg)):
    """Example PostgreSQL query, shown on the Activity Dashboard page."""
    (rows,) = conn.execute("SELECT count(*) FROM zone_hour_observation").fetchone()
    return {"zone_hour_rows": rows}
