"""Remove one imported month so it can be imported again.

    python etl/delete_month.py --month 2026-01

Use it when an import rule changes or TLC republishes a month. Users, plans
and saved views are kept (docker compose down -v would delete those too).

In one PostgreSQL transaction it removes the month's trips (its partition) and
their warnings, its rejected rows, its hourly summaries and its import_batch
row. Then it refreshes the materialised views and deletes the month's MongoDB
documents. Running it again is harmless.

Afterwards, import the month again (the loader does it on the next
docker compose up). If the following month is loaded, rebuild its summaries
too (build_aggregates.py and load_mongo.py), because drop-offs late on this
month's last day are counted there.
"""
import argparse
import sys

from build_aggregates import refresh
from common import mongo_db, next_month, parse_month, pg_connect
from load_mongo import HOURLY, OD


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True, help="YYYY-MM")
    args = ap.parse_args()
    start = parse_month(args.month)
    end = next_month(start)
    partition = f"trip_{start:%Y_%m}"

    with pg_connect(autocommit=True) as conn:
        with conn.transaction():
            batch = conn.execute(
                "SELECT import_batch_id FROM import_batch WHERE file_month = %s", (start,)
            ).fetchone()
            batch_id = batch[0] if batch else None
            warnings = rejected = trips = 0
            if batch_id is not None:
                warnings = conn.execute(
                    "DELETE FROM trip_warning WHERE import_batch_id = %s", (batch_id,)
                ).rowcount
                rejected = conn.execute(
                    "DELETE FROM rejected_trip WHERE import_batch_id = %s", (batch_id,)
                ).rowcount
            if conn.execute("SELECT to_regclass(%s) IS NOT NULL", (partition,)).fetchone()[0]:
                trips = conn.execute(f"SELECT count(*) FROM {partition}").fetchone()[0]
                # Detach first: trip_warning's foreign key points at the
                # partitioned trip table, so the partition can't be dropped
                # while attached.
                conn.execute(f"ALTER TABLE trip DETACH PARTITION {partition}")
                conn.execute(f"DROP TABLE {partition}")
            hours = conn.execute(
                "DELETE FROM zone_hour_observation WHERE obs_hour >= %s AND obs_hour < %s",
                (start, end),
            ).rowcount
            if batch_id is not None:
                conn.execute("DELETE FROM import_batch WHERE import_batch_id = %s", (batch_id,))
        print(f"{args.month} PostgreSQL: {trips:,} trips, {warnings:,} warnings, "
              f"{rejected:,} rejected rows, {hours:,} hourly rows"
              + (f", import batch {batch_id}" if batch_id is not None else " (no import batch)"))

        refresh(conn, "od_summary")
        refresh(conn, "zone_weekday_hour_fare")
        next_loaded = conn.execute(
            "SELECT 1 FROM import_batch WHERE file_month = %s", (end,)
        ).fetchone() is not None

    db = mongo_db()
    hourly = db[HOURLY].delete_many(
        {"localDate": {"$gte": start.isoformat(), "$lt": end.isoformat()}}
    ).deleted_count
    od = db[OD].delete_many({"month": f"{start:%Y-%m}"}).deleted_count
    print(f"{args.month} MongoDB: {hourly:,} hourly documents, {od:,} origin-destination documents")

    print(f"\n{args.month} removed. Import it again with the loader (docker compose up -d) "
          f"or etl/import_month.py.")
    if next_loaded:
        print(f"Then rebuild {end:%Y-%m}'s summaries too: build_aggregates.py and "
              f"load_mongo.py --month {end:%Y-%m}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
