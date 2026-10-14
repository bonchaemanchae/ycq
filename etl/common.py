"""Shared settings and connections for the ETL scripts."""
import os
import re
from datetime import date
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SQL = ROOT / "sql"

load_dotenv(ROOT / ".env")


def pg_connect(**kwargs) -> psycopg.Connection:
    return psycopg.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        dbname=os.getenv("POSTGRES_DB", "ycq"),
        user=os.getenv("POSTGRES_USER", "ycq"),
        password=os.environ["POSTGRES_PASSWORD"],
        **kwargs,
    )


def mongo_db():
    client = MongoClient(
        host=os.getenv("MONGO_HOST", "localhost"),
        port=int(os.getenv("MONGO_PORT", "27017")),
        username=os.getenv("MONGO_USER", "ycq"),
        password=os.environ["MONGO_PASSWORD"],
        tz_aware=True,
    )
    return client[os.getenv("MONGO_DB", "ycq")]


def parse_month(value: str) -> date:
    """'2026-01' -> date(2026, 1, 1)."""
    if not re.fullmatch(r"\d{4}-\d{2}", value):
        raise ValueError(f"month must look like YYYY-MM, got {value!r}")
    y, m = map(int, value.split("-"))
    return date(y, m, 1)


def next_month(d: date) -> date:
    return date(d.year + d.month // 12, d.month % 12 + 1, 1)
