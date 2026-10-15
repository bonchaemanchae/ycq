"""Load everything in one go: download, schema, zones, then each month.

    python etl/load_all.py                         # months from YCQ_MONTHS, or all three
    python etl/load_all.py --months 2026-01        # just January (quicker)

This is what the `loader` service in docker-compose.yml runs, but it works
outside Docker too. Safe to run again: a month already imported is skipped,
and its summaries and MongoDB documents are only rebuilt if they are missing.

Set YCQ_DOWNLOAD=0 to use files already in data/ without downloading.
"""
import argparse
import os
import subprocess
import sys
import time

from common import ROOT, mongo_db, next_month, parse_month, pg_connect
from load_mongo import HOURLY, ensure_app_user, ensure_collections

DEFAULT_MONTHS = ["2026-01", "2026-02", "2026-03"]


def run(*args: str) -> None:
    print(f"\n==> {' '.join(args)}", flush=True)
    result = subprocess.run([sys.executable, *args], cwd=ROOT)
    if result.returncode != 0:
        sys.exit(f"{args[0]} failed (exit {result.returncode})")


def wait_for_databases(timeout_s: int = 120) -> None:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            with pg_connect(connect_timeout=3) as conn:
                conn.execute("SELECT 1")
            mongo_db().client.admin.command("ping")
            return
        except Exception as e:
            if time.monotonic() > deadline:
                sys.exit(f"databases not reachable: {e}")
            print("waiting for PostgreSQL and MongoDB...", flush=True)
            time.sleep(3)


def month_state(month: str) -> tuple[bool, bool, bool]:
    """(imported, summarised, in MongoDB) for one month."""
    start = parse_month(month)
    end = next_month(start)
    with pg_connect() as conn:
        imported = conn.execute(
            "SELECT 1 FROM import_batch WHERE file_month = %s AND status = 'completed'", (start,)
        ).fetchone() is not None
        summarised = conn.execute(
            "SELECT 1 FROM zone_hour_observation WHERE obs_hour >= %s AND obs_hour < %s LIMIT 1",
            (start, end),
        ).fetchone() is not None
    in_mongo = mongo_db()[HOURLY].count_documents(
        {"localDate": {"$gte": start.isoformat(), "$lt": end.isoformat()}}, limit=1
    ) > 0
    return imported, summarised, in_mongo


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", nargs="*",
                    default=os.getenv("YCQ_MONTHS", " ".join(DEFAULT_MONTHS)).split())
    args = ap.parse_args()
    for m in args.months:
        parse_month(m)   # fail early on a typo
    t0 = time.perf_counter()

    wait_for_databases()
    if os.getenv("YCQ_DOWNLOAD", "1") != "0":
        run("scripts/download_data.py", "--months", *args.months)
    run("etl/setup_db.py")
    run("etl/load_zones.py")
    # Re-applies the MongoDB validators and indexes, so a change to them in
    # load_mongo.py reaches databases whose months are already loaded.
    ensure_collections(mongo_db())
    ensure_app_user(mongo_db().client)

    for month in args.months:
        imported, summarised, in_mongo = month_state(month)
        if imported and summarised and in_mongo:
            print(f"\n==> {month} already loaded, skipping")
            continue
        if not imported:
            run("etl/import_month.py", "--month", month)
        if not imported or not summarised:
            run("etl/build_aggregates.py", "--month", month)
        run("etl/load_mongo.py", "--month", month)
        run("etl/reconcile.py", "--month", month)

    print(f"\nall loaded: {', '.join(args.months)} ({time.perf_counter() - t0:.0f}s)")


if __name__ == "__main__":
    main()
