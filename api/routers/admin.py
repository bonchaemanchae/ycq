"""Administration routes. TODO (Sean): replace the example.

Served at /admin/... here and at /api/admin/... from the website.
"""
from fastapi import APIRouter, Depends
from psycopg.rows import dict_row

from ..db import get_pg

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/example")
def example(conn=Depends(get_pg)):
    """Example query returning rows as dicts, shown on the Administration page."""
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            """SELECT file_month, source_file, rows_read, rows_accepted, rows_rejected, status
               FROM import_batch ORDER BY file_month""").fetchall()
