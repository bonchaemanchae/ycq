"""Flow Explorer routes. TODO (Caleb): replace the example.

Served at /flows/... here and at /api/flows/... from the website.
"""
from fastapi import APIRouter

from ..db import mongo

router = APIRouter(prefix="/flows", tags=["flows"])


@router.get("/example")
def example():
    """Example MongoDB query, shown on the Flow Explorer page."""
    db = mongo()
    return {
        name: db[name].estimated_document_count()
        for name in ("zone_activity_timeseries", "origin_destination_snapshots",
                     "saved_analysis_views")
    }
