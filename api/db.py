"""Shared database connections for the API.

One PostgreSQL pool and one MongoDB client for the whole app. Routes get a
connection with `Depends(get_pg)` and the Mongo database with `mongo()`.
PostgreSQL connections are in autocommit mode, so wrap multi-statement
writes in `with conn.transaction():` (api/planner.py does).
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from psycopg_pool import ConnectionPool
from pymongo import MongoClient

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _pg_conninfo() -> str:
    return (
        f"host={os.getenv('POSTGRES_HOST', 'localhost')} "
        f"port={os.getenv('POSTGRES_PORT', '5432')} "
        f"dbname={os.getenv('POSTGRES_DB', 'ycq')} "
        f"user={os.getenv('POSTGRES_USER', 'ycq')} "
        f"password={os.environ['POSTGRES_PASSWORD']}"
    )


pg_pool = ConnectionPool(_pg_conninfo(), open=False, min_size=1, max_size=10,
                         kwargs={"autocommit": True})
mongo_client = MongoClient(
    host=os.getenv("MONGO_HOST", "localhost"),
    port=int(os.getenv("MONGO_PORT", "27017")),
    username=os.getenv("MONGO_USER", "ycq"),
    password=os.environ["MONGO_PASSWORD"],
    tz_aware=True,
)


def mongo():
    return mongo_client[os.getenv("MONGO_DB", "ycq")]


def get_pg():
    """FastAPI dependency: one pooled PostgreSQL connection per request."""
    with pg_pool.connection() as conn:
        yield conn
