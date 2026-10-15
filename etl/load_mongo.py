"""Copy one month of summaries from PostgreSQL into MongoDB.

    python load_mongo.py --month 2026-01

Creates the collections (with $jsonSchema validators and indexes) if needed,
deletes that month's documents, then inserts them again from
zone_hour_observation and od_summary. Time-series collections don't enforce
unique keys, so the loader always deletes before inserting.
"""
import argparse
import os
import time
from collections import defaultdict
from datetime import timezone

from pymongo import ASCENDING, DESCENDING
from pymongo.errors import CollectionInvalid

from common import mongo_db, next_month, parse_month, pg_connect

HOURLY = "zone_activity_timeseries"
OD = "origin_destination_snapshots"
VIEWS = "saved_analysis_views"
TOP_N = 10

NUM = ["double", "int", "long", "decimal"]
NUM_OR_NULL = NUM + ["null"]

HOURLY_SCHEMA = {
    "$jsonSchema": {
        "bsonType": "object",
        "required": ["timestamp", "meta", "localDate", "localHour", "isoDayOfWeek",
                     "pickups", "dropoffs", "imbalance", "fareSum", "fareTripCount"],
        "properties": {
            "timestamp": {"bsonType": "date"},
            "meta": {
                "bsonType": "object",
                "required": ["zoneId", "borough"],
                "properties": {
                    "zoneId": {"bsonType": "int", "minimum": 1, "maximum": 265},
                    "borough": {"bsonType": "string"},
                },
            },
            "localDate": {"bsonType": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
            "localHour": {"bsonType": "int", "minimum": 0, "maximum": 23},
            "isoDayOfWeek": {"bsonType": "int", "minimum": 1, "maximum": 7},
            "pickups": {"bsonType": "int", "minimum": 0},
            "dropoffs": {"bsonType": "int", "minimum": 0},
            "imbalance": {"bsonType": "int"},
            "fareSum": {"bsonType": NUM, "minimum": 0},
            "fareTripCount": {"bsonType": "int", "minimum": 0},
            "averageFare": {"bsonType": NUM_OR_NULL},
            "distanceSum": {"bsonType": NUM},
            "distanceTripCount": {"bsonType": "int", "minimum": 0},
            "averageDistance": {"bsonType": NUM_OR_NULL},
            "durationSumSec": {"bsonType": NUM},
            "durationTripCount": {"bsonType": "int", "minimum": 0},
            "averageDurationSec": {"bsonType": NUM_OR_NULL},
        },
    }
}

DEST_SCHEMA = {
    "bsonType": "object",
    "required": ["zoneId", "trips", "share"],
    "properties": {
        "zoneId": {"bsonType": "int"},
        "zoneName": {"bsonType": "string"},
        "borough": {"bsonType": "string"},
        "rank": {"bsonType": "int", "minimum": 1, "maximum": TOP_N},
        "trips": {"bsonType": "int", "minimum": 1},
        "share": {"bsonType": "double", "minimum": 0, "maximum": 1},
        "averageFare": {"bsonType": NUM_OR_NULL},
        "averageDistance": {"bsonType": NUM_OR_NULL},
        "averageDurationSec": {"bsonType": NUM_OR_NULL},
    },
}

OD_SCHEMA = {
    "$jsonSchema": {
        "bsonType": "object",
        "required": ["originZoneId", "month", "dayType", "timeBucket", "totalTrips", "destinations"],
        "properties": {
            "originZoneId": {"bsonType": "int"},
            "originBorough": {"bsonType": "string"},
            "month": {"bsonType": "string", "pattern": r"^\d{4}-\d{2}$"},
            "dayType": {"enum": ["weekday", "weekend"]},
            "timeBucket": {"enum": ["night", "am_peak", "midday", "pm_peak", "evening"]},
            "totalTrips": {"bsonType": "int", "minimum": 1},
            "destinationCount": {"bsonType": "int", "minimum": 1},
            "destinations": {"bsonType": "array", "maxItems": TOP_N, "items": DEST_SCHEMA},
        },
    }
}

VIEWS_SCHEMA = {
    "$jsonSchema": {
        "bsonType": "object",
        "required": ["ownerUserId", "name", "filters", "createdAt", "updatedAt"],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "objectId"},
            "ownerUserId": {"bsonType": "int"},
            "name": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "page": {"enum": ["dashboard", "flows"]},
            "filters": {
                "bsonType": "object",
                "additionalProperties": False,
                "properties": {
                    "dateFrom": {"bsonType": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "dateTo": {"bsonType": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "weekdays": {"bsonType": "array", "items": {"bsonType": "int", "minimum": 1, "maximum": 7}},
                    "hourFrom": {"bsonType": "int", "minimum": 0, "maximum": 23},
                    "hourTo": {"bsonType": "int", "minimum": 0, "maximum": 23},
                    "boroughs": {"bsonType": "array", "items": {"bsonType": "string"}},
                    "zoneIds": {"bsonType": "array", "items": {"bsonType": "int"}},
                    "metric": {"enum": ["pickups", "dropoffs", "imbalance"]},
                },
            },
            "widgets": {"bsonType": "object"},
            "createdAt": {"bsonType": "date"},
            "updatedAt": {"bsonType": "date"},
        },
    }
}


def ensure_collections(db) -> None:
    existing = set(db.list_collection_names())
    # MongoDB 8.0 refuses validators on time-series collections, so
    # HOURLY_SCHEMA is checked as a $jsonSchema query after each load instead.
    if HOURLY not in existing:
        db.create_collection(
            HOURLY,
            timeseries={"timeField": "timestamp", "metaField": "meta", "granularity": "hours"},
        )
    db[HOURLY].create_index([("meta.zoneId", ASCENDING), ("timestamp", ASCENDING)])
    db[HOURLY].create_index([("localDate", ASCENDING), ("localHour", ASCENDING)])
    # Weekday + hour, like PostgreSQL's zone_hour_dow_hour_idx: the planner's
    # statistics (and its PostgreSQL vs MongoDB comparison) filter on these.
    db[HOURLY].create_index([("isoDayOfWeek", ASCENDING), ("localHour", ASCENDING)])

    for name, schema in ((OD, OD_SCHEMA), (VIEWS, VIEWS_SCHEMA)):
        try:
            db.create_collection(name, validator=schema, validationLevel="strict")
        except CollectionInvalid:
            db.command("collMod", name, validator=schema, validationLevel="strict")
    db[OD].create_index(
        [("originZoneId", ASCENDING), ("month", ASCENDING), ("dayType", ASCENDING), ("timeBucket", ASCENDING)],
        unique=True,
    )
    db[VIEWS].create_index([("ownerUserId", ASCENDING), ("updatedAt", DESCENDING)])
    db[VIEWS].create_index([("ownerUserId", ASCENDING), ("name", ASCENDING)], unique=True)


def ensure_app_user(client) -> None:
    """The API's own MongoDB login: read and write on the ycq database only.

    The loader runs as the root user it was started with; the API uses this
    one instead (MONGO_APP_USER / MONGO_APP_PASSWORD), so it can't touch other
    databases or users. Created on the first run, password and role updated
    on later runs.
    """
    user, password = os.getenv("MONGO_APP_USER"), os.getenv("MONGO_APP_PASSWORD")
    if not user or not password:
        return
    roles = [{"role": "readWrite", "db": os.getenv("MONGO_DB", "ycq")}]
    if client.admin.command("usersInfo", user)["users"]:
        client.admin.command("updateUser", user, pwd=password, roles=roles)
    else:
        client.admin.command("createUser", user, pwd=password, roles=roles)
    print(f"MongoDB app user {user!r}: readWrite on {roles[0]['db']}")


def avg(total, count):
    return round(float(total) / count, 4) if count else None


# The numbers in each document, from PostgreSQL's sums and counts. reconcile.py
# uses the same functions to check every field.

def hourly_fields(pu, do, fare_sum, fare_n, dist_sum, dist_n, dur_sum, dur_n) -> dict:
    return {
        "pickups": pu,
        "dropoffs": do,
        "imbalance": pu - do,
        "fareSum": float(fare_sum),
        "fareTripCount": fare_n,
        "averageFare": avg(fare_sum, fare_n),
        "distanceSum": float(dist_sum),
        "distanceTripCount": dist_n,
        "averageDistance": avg(dist_sum, dist_n),
        "durationSumSec": float(dur_sum),
        "durationTripCount": dur_n,
        "averageDurationSec": avg(dur_sum, dur_n),
    }


def destination_fields(trips, total, fare_sum, fare_n, dist_sum, dist_n, dur_sum, dur_n) -> dict:
    return {
        "trips": trips,
        "share": round(trips / total, 6),
        "averageFare": avg(fare_sum, fare_n),
        "averageDistance": avg(dist_sum, dist_n),
        "averageDurationSec": avg(dur_sum, dur_n),
    }


def load_hourly(conn, db, start, end) -> int:
    coll = db[HOURLY]
    deleted = coll.delete_many(
        {"localDate": {"$gte": start.isoformat(), "$lt": end.isoformat()}}
    ).deleted_count
    cur = conn.execute(
        """
        SELECT h.location_id, b.name, h.obs_hour_utc, h.local_date, h.local_hour, h.iso_dow,
               h.pickups, h.dropoffs, h.fare_sum, h.fare_trip_count,
               h.distance_sum, h.distance_trip_count, h.duration_sum_s, h.duration_trip_count
        FROM zone_hour_observation h
        JOIN taxi_zone z USING (location_id)
        JOIN borough b USING (borough_id)
        WHERE h.obs_hour >= %s AND h.obs_hour < %s
        ORDER BY h.obs_hour, h.location_id
        """,
        (start, end),
    )
    inserted = 0
    batch = []
    for (zone, borough, ts, local_date, hour, dow, pu, do, fare_sum, fare_n,
         dist_sum, dist_n, dur_sum, dur_n) in cur:
        batch.append({
            "timestamp": ts.astimezone(timezone.utc),
            "meta": {"zoneId": zone, "borough": borough},
            "localDate": local_date.isoformat(),
            "localHour": hour,
            "isoDayOfWeek": dow,
            **hourly_fields(pu, do, fare_sum, fare_n, dist_sum, dist_n, dur_sum, dur_n),
        })
        if len(batch) == 20_000:
            inserted += len(coll.insert_many(batch, ordered=False).inserted_ids)
            batch = []
    if batch:
        inserted += len(coll.insert_many(batch, ordered=False).inserted_ids)
    month_filter = {"localDate": {"$gte": start.isoformat(), "$lt": end.isoformat()}}
    invalid = coll.count_documents({**month_filter, "$nor": [HOURLY_SCHEMA]})
    if invalid:
        coll.delete_many(month_filter)
        raise RuntimeError(f"{invalid} {HOURLY} documents failed the schema check; month removed")
    print(f"{HOURLY}: deleted {deleted:,}, inserted {inserted:,}, schema check passed")
    return inserted


def load_od(conn, db, start) -> int:
    coll = db[OD]
    month = f"{start:%Y-%m}"
    deleted = coll.delete_many({"month": month}).deleted_count
    cur = conn.execute(
        """
        SELECT o.day_type, o.time_bucket, o.origin_location_id, ob.name,
               o.dest_location_id, dz.zone_name, db.name,
               o.trips, o.fare_sum, o.fare_trip_count, o.distance_sum,
               o.distance_trip_count, o.duration_sum_s, o.duration_trip_count
        FROM od_summary o
        JOIN taxi_zone oz ON oz.location_id = o.origin_location_id
        JOIN borough ob ON ob.borough_id = oz.borough_id
        JOIN taxi_zone dz ON dz.location_id = o.dest_location_id
        JOIN borough db ON db.borough_id = dz.borough_id
        WHERE o.month = %s
        """,
        (start,),
    )
    groups = defaultdict(list)
    origin_borough = {}
    for row in cur:
        day_type, bucket, origin, o_borough = row[:4]
        groups[(origin, day_type, bucket)].append(row[4:])
        origin_borough[origin] = o_borough

    docs = []
    for (origin, day_type, bucket), dests in groups.items():
        total = sum(d[3] for d in dests)
        dests.sort(key=lambda d: (-d[3], d[0]))   # most trips first, ties by zone id
        docs.append({
            "originZoneId": origin,
            "originBorough": origin_borough[origin],
            "month": month,
            "dayType": day_type,
            "timeBucket": bucket,
            "totalTrips": total,
            "destinationCount": len(dests),
            "destinations": [
                {
                    "rank": i,
                    "zoneId": dest, "zoneName": zname, "borough": dborough,
                    **destination_fields(trips, total, fs, fn, ds, dn, us, un),
                }
                for i, (dest, zname, dborough, trips, fs, fn, ds, dn, us, un)
                in enumerate(dests[:TOP_N], start=1)
            ],
        })
    if docs:
        coll.insert_many(docs, ordered=False)
    print(f"{OD}: deleted {deleted:,}, inserted {len(docs):,}")
    return len(docs)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True, help="YYYY-MM")
    args = ap.parse_args()
    start = parse_month(args.month)
    end = next_month(start)

    t0 = time.perf_counter()
    db = mongo_db()
    ensure_collections(db)
    with pg_connect() as conn:
        load_hourly(conn, db, start, end)
        load_od(conn, db, start)
    print(f"done ({time.perf_counter() - t0:.1f}s)")


if __name__ == "__main__":
    main()
