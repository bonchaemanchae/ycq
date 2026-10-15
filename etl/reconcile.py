"""Check that MongoDB's summaries for a month match PostgreSQL.

    python reconcile.py --month 2026-01

Hourly zone activity: the document count, total pickups and drop-offs, and
every number in every zone-hour document (pickups, drop-offs, imbalance, the
fare, distance and duration sums and counts, and the three averages), each
recomputed from zone_hour_observation.

Origin-destination: every slice's total trips and destination count, the
top destinations in order, and each destination's trips, share and averages,
recomputed from od_summary.

The result is stored in reconciliation_run. Exits 1 if anything differs.
"""
import argparse
import math
import sys

from psycopg.types.json import Jsonb

from common import mongo_db, next_month, parse_month, pg_connect
from load_mongo import HOURLY, OD, TOP_N, destination_fields, hourly_fields

SAMPLE = 20   # mismatches kept in details
HOURLY_FIELDS = list(hourly_fields(0, 0, 0, 0, 0, 0, 0, 0))


def same(expected, actual) -> bool:
    if isinstance(expected, float) or isinstance(actual, float):
        return (expected is not None and actual is not None
                and math.isclose(expected, actual, rel_tol=1e-9, abs_tol=1e-6))
    return expected == actual


def differing(expected: dict, actual: dict) -> list[str]:
    return [k for k, v in expected.items() if not same(v, actual.get(k))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True, help="YYYY-MM")
    args = ap.parse_args()
    start = parse_month(args.month)
    end = next_month(start)
    db = mongo_db()
    month_filter = {"localDate": {"$gte": start.isoformat(), "$lt": end.isoformat()}}

    with pg_connect(autocommit=True) as conn:
        run_id = conn.execute(
            "INSERT INTO reconciliation_run (month) VALUES (%s) RETURNING reconciliation_run_id",
            (start,),
        ).fetchone()[0]

        # --- hourly zone activity -------------------------------------------
        pg_hours = {
            (zone, d.isoformat(), h): hourly_fields(*values)
            for zone, d, h, *values in conn.execute(
                """SELECT location_id, local_date, local_hour, pickups, dropoffs,
                          fare_sum, fare_trip_count, distance_sum, distance_trip_count,
                          duration_sum_s, duration_trip_count
                   FROM zone_hour_observation
                   WHERE obs_hour >= %s AND obs_hour < %s""",
                (start, end),
            )
        }
        mongo_hours = {}
        mongo_dupes = 0
        projection = {"_id": 0, "meta.zoneId": 1, "localDate": 1, "localHour": 1,
                      **{f: 1 for f in HOURLY_FIELDS}}
        for doc in db[HOURLY].find(month_filter, projection):
            key = (doc["meta"]["zoneId"], doc["localDate"], doc["localHour"])
            if key in mongo_hours:
                mongo_dupes += 1
            mongo_hours[key] = doc

        zone_hour_diffs = []
        for key in pg_hours.keys() | mongo_hours.keys():
            expected, actual = pg_hours.get(key), mongo_hours.get(key)
            if expected is None or actual is None:
                problem = ["missing in MongoDB"] if actual is None else ["only in MongoDB"]
            else:
                problem = differing(expected, actual)
            if problem:
                zone_hour_diffs.append({"zone": key[0], "date": key[1], "hour": key[2],
                                        "fields": problem})
        zone_hour_diffs.sort(key=lambda d: (d["date"], d["hour"], d["zone"]))

        mongo_doc_count = db[HOURLY].count_documents(month_filter)
        pg_pickups = sum(v["pickups"] for v in pg_hours.values())
        pg_dropoffs = sum(v["dropoffs"] for v in pg_hours.values())
        totals = list(db[HOURLY].aggregate([
            {"$match": month_filter},
            {"$group": {"_id": None, "pickups": {"$sum": "$pickups"}, "dropoffs": {"$sum": "$dropoffs"}}},
        ]))
        mongo_pickups = totals[0]["pickups"] if totals else 0
        mongo_dropoffs = totals[0]["dropoffs"] if totals else 0

        # --- origin-destination ---------------------------------------------
        month = f"{start:%Y-%m}"
        pg_od = {}
        for day_type, bucket, origin, dest, *values in conn.execute(
            """SELECT day_type, time_bucket, origin_location_id, dest_location_id,
                      trips, fare_sum, fare_trip_count, distance_sum, distance_trip_count,
                      duration_sum_s, duration_trip_count
               FROM od_summary WHERE month = %s""",
            (start,),
        ):
            pg_od.setdefault((origin, day_type, bucket), {})[dest] = values

        od_diffs = []
        seen = set()
        for doc in db[OD].find({"month": month}):
            key = (doc["originZoneId"], doc["dayType"], doc["timeBucket"])
            seen.add(key)
            pg = pg_od.get(key)
            if pg is None:
                od_diffs.append({"slice": key, "problem": "only in MongoDB"})
                continue
            total = sum(v[0] for v in pg.values())
            if doc["totalTrips"] != total:
                od_diffs.append({"slice": key, "problem": "total trips",
                                 "postgres": total, "mongo": doc["totalTrips"]})
            if doc.get("destinationCount") != len(pg):
                od_diffs.append({"slice": key, "problem": "destination count",
                                 "postgres": len(pg), "mongo": doc.get("destinationCount")})
            expected_top = sorted(pg, key=lambda dest: (-pg[dest][0], dest))[:TOP_N]
            actual_top = [d["zoneId"] for d in doc["destinations"]]
            if actual_top != expected_top:
                od_diffs.append({"slice": key, "problem": "top destinations differ"})
                continue
            for rank, d in enumerate(doc["destinations"], start=1):
                fields = differing(
                    {"rank": rank, **destination_fields(pg[d["zoneId"]][0], total, *pg[d["zoneId"]][1:])}, d)
                if fields:
                    od_diffs.append({"slice": key, "problem": "destination fields",
                                     "destination": d["zoneId"], "fields": fields})
        for key in pg_od.keys() - seen:
            od_diffs.append({"slice": key, "problem": "missing in MongoDB"})

        passed = (
            not zone_hour_diffs and not od_diffs and mongo_dupes == 0
            and len(pg_hours) == mongo_doc_count
            and pg_pickups == mongo_pickups and pg_dropoffs == mongo_dropoffs
        )
        details = {
            "mongo_duplicate_docs": mongo_dupes,
            "pg_od_slices": len(pg_od),
            "mongo_od_slices": len(seen),
            "fields_checked": {"hourly": HOURLY_FIELDS,
                               "destinations": ["rank", *destination_fields(1, 1, 0, 0, 0, 0, 0, 0)]},
            "zone_hour_mismatch_sample": zone_hour_diffs[:SAMPLE],
            "od_mismatch_sample": [{**d, "slice": list(d["slice"])} for d in od_diffs[:SAMPLE]],
        }
        conn.execute(
            """UPDATE reconciliation_run
                  SET finished_at = now(), passed = %s,
                      pg_hour_rows = %s, mongo_hour_docs = %s,
                      pg_pickups = %s, mongo_pickups = %s,
                      pg_dropoffs = %s, mongo_dropoffs = %s,
                      zone_hour_mismatches = %s, od_mismatches = %s, details = %s
                WHERE reconciliation_run_id = %s""",
            (passed, len(pg_hours), mongo_doc_count, pg_pickups, mongo_pickups,
             pg_dropoffs, mongo_dropoffs, len(zone_hour_diffs), len(od_diffs),
             Jsonb(details), run_id),
        )

    print(f"reconciliation run {run_id} for {month}: {'PASSED' if passed else 'FAILED'}")
    print(f"  hourly rows      postgres {len(pg_hours):>10,}   mongo {mongo_doc_count:>10,}")
    print(f"  pickups          postgres {pg_pickups:>10,}   mongo {mongo_pickups:>10,}")
    print(f"  dropoffs         postgres {pg_dropoffs:>10,}   mongo {mongo_dropoffs:>10,}")
    print(f"  zone-hour mismatches {len(zone_hour_diffs):,} "
          f"(checked {len(HOURLY_FIELDS)} fields per document)")
    print(f"  od slices        postgres {len(pg_od):>10,}   mongo {len(seen):>10,}   mismatches {len(od_diffs):,}")
    for d in zone_hour_diffs[:5]:
        print(f"    {d}")
    for d in od_diffs[:5]:
        print(f"    {d}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
