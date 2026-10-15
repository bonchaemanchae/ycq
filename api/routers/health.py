from fastapi import APIRouter, Depends

from ..db import get_pg, mongo

router = APIRouter(tags=["health"])


@router.get("/health")
def health(conn=Depends(get_pg)):
    """Both databases reachable, and which months are loaded."""
    months = [m.isoformat()[:7] for (m,) in conn.execute(
        "SELECT file_month FROM import_batch WHERE status = 'completed' ORDER BY file_month")]
    return {
        "postgres": True,
        "mongodb": mongo().command("ping")["ok"] == 1,
        "months_loaded": months,
    }
