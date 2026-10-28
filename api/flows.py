"""Flow Explorer: top ten destinations from a zone, from MongoDB snapshots.

Plain functions that take the origin_destination_snapshots collection, so the
FastAPI routes only parse the query, call one of these and return the result.
Each snapshot is one origin zone x month x day type x time bucket, built from
PostgreSQL's od_summary by etl/load_mongo.py, with the top 10 destinations
embedded. The queries $unwind that embedded list.

    q = SliceQuery(originZoneId=161, month="2026-01", dayType="weekday", timeBucket="am_peak")
    get_slice(coll, q)              # header + top 10 rows; found=False if no trips
    compare_months(coll, CompareQuery(originZoneId=161, dayType="weekday", timeBucket="am_peak"))

Every value in a pipeline comes from a validated model field (an int, an enum
or a month matching YYYY-MM); operator names are fixed here, so nothing the
client sends can become a MongoDB operator.

The same top 10 in PostgreSQL, on the od_summary materialised view (for the
benchmark; share and the averages are computed as the loader does):

    SELECT o.dest_location_id, z.zone_name, b.name AS borough, o.trips,
           round(o.trips::numeric / sum(o.trips) OVER (), 6)              AS share,
           round(o.fare_sum / nullif(o.fare_trip_count, 0), 4)            AS average_fare,
           round(o.distance_sum / nullif(o.distance_trip_count, 0), 4)    AS average_distance,
           round(o.duration_sum_s::numeric / nullif(o.duration_trip_count, 0), 4) AS average_duration_sec
    FROM od_summary o
    JOIN taxi_zone z ON z.location_id = o.dest_location_id
    JOIN borough b USING (borough_id)
    WHERE o.month = '2026-01-01' AND o.day_type = 'weekday'
      AND o.time_bucket = 'am_peak' AND o.origin_location_id = 161
    ORDER BY o.trips DESC, o.dest_location_id
    LIMIT 10;

The window sum runs before LIMIT, so share is out of all the origin's trips in
that slice, like totalTrips. It uses the od_summary_uq index. The loader
rounds the averages as Python floats and PostgreSQL rounds exact numerics, so
a value ending in exactly 5 can differ in the 4th decimal (zone 161 -> 237:
0.9487 vs 0.9488 miles); everything else matches.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pymongo.collection import Collection

from .filters import ZoneId

COLLECTION = "origin_destination_snapshots"

DayType = Literal["weekday", "weekend"]
# Local pickup hour: night 0-5, am_peak 6-9, midday 10-15, pm_peak 16-19, evening 20-23
TimeBucket = Literal["night", "am_peak", "midday", "pm_peak", "evening"]

DEST_FIELDS = ("rank", "zoneId", "zoneName", "borough", "trips", "share",
               "averageFare", "averageDistance", "averageDurationSec")


class CompareQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    originZoneId: ZoneId
    dayType: DayType
    timeBucket: TimeBucket


class SliceQuery(CompareQuery):
    month: str = Field(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")


# --- pipelines ---------------------------------------------------------------

def slice_pipeline(q: SliceQuery) -> list[dict]:
    """One snapshot's destinations as flat rows, best first. Each row also
    carries the slice header (totalTrips etc.); get_slice lifts it off."""
    return [
        {"$match": {"originZoneId": q.originZoneId, "month": q.month,
                    "dayType": q.dayType, "timeBucket": q.timeBucket}},
        {"$unwind": {"path": "$destinations", "includeArrayIndex": "position"}},
        {"$project": {"_id": 0, "originBorough": 1, "totalTrips": 1, "destinationCount": 1,
                      "position": 1,
                      **{f: f"$destinations.{f}" for f in DEST_FIELDS}}},
        {"$sort": {"rank": 1, "position": 1}},
    ]


def compare_pipeline(q: CompareQuery) -> list[dict]:
    """Every month's snapshot for one origin, day type and time bucket: a
    header per month, and each destination's rank, trips and share per month
    from that month's top 10."""
    return [
        {"$match": {"originZoneId": q.originZoneId, "dayType": q.dayType,
                    "timeBucket": q.timeBucket}},
        {"$facet": {
            "months": [
                {"$project": {"_id": 0, "month": 1, "totalTrips": 1, "destinationCount": 1,
                              "listed": {"$size": "$destinations"}}},
            ],
            "destinations": [
                {"$unwind": "$destinations"},
                {"$group": {"_id": "$destinations.zoneId",
                            "zoneName": {"$first": "$destinations.zoneName"},
                            "borough": {"$first": "$destinations.borough"},
                            "monthsInTop10": {"$sum": 1},
                            "listedTrips": {"$sum": "$destinations.trips"},
                            "byMonth": {"$push": {"month": "$month",
                                                  "rank": "$destinations.rank",
                                                  "trips": "$destinations.trips",
                                                  "share": "$destinations.share"}}}},
                {"$sort": {"monthsInTop10": -1, "listedTrips": -1, "_id": 1}},
            ],
        }},
    ]


# --- queries -----------------------------------------------------------------

def get_slice(coll: Collection, q: SliceQuery) -> dict:
    """The top destinations for one slice. A slice with no trips (common for
    quiet zones at night) is a normal answer: found=False and no rows."""
    rows = list(coll.aggregate(slice_pipeline(q)))
    if not rows:
        return {"found": False, **q.model_dump(), "originBorough": None, "totalTrips": 0,
                "destinationCount": 0, "topTrips": 0, "topShare": None, "destinations": []}
    head = rows[0]
    destinations = [{f: r.get(f) for f in DEST_FIELDS} for r in rows]
    top = sum(d["trips"] for d in destinations)
    return {
        "found": True,
        **q.model_dump(),
        "originBorough": head.get("originBorough"),
        "totalTrips": head["totalTrips"],
        "destinationCount": head.get("destinationCount"),
        "topTrips": top,
        # From trips, not by adding up the rounded shares.
        "topShare": round(top / head["totalTrips"], 4),
        "destinations": destinations,
    }


def loaded_months(coll: Collection) -> list[str]:
    """Months that have snapshots, oldest first."""
    return sorted(coll.distinct("month"))


def compare_months(coll: Collection, q: CompareQuery) -> dict:
    """One origin, day type and time bucket across every loaded month.

    Built from each month's top 10 only. byMonth[m] is null when the zone
    isn't in month m's list: if that month's list is complete (it holds every
    destination) the zone really had no trips, otherwise it may have had a
    few. A month with no snapshot at all has found=False."""
    months = loaded_months(coll)
    facet = next(coll.aggregate(compare_pipeline(q)))
    headers = {m["month"]: m for m in facet["months"]}
    destinations = []
    for g in facet["destinations"]:
        listed = {e["month"]: {"rank": e.get("rank"), "trips": e["trips"], "share": e["share"]}
                  for e in g["byMonth"]}
        destinations.append({
            "zoneId": g["_id"], "zoneName": g.get("zoneName"), "borough": g.get("borough"),
            "monthsInTop10": g["monthsInTop10"], "listedTrips": g["listedTrips"],
            "byMonth": {m: listed.get(m) for m in months},
        })
    return {
        "basis": "each month's top 10 only",
        **q.model_dump(),
        "months": [
            {"month": m, "found": True, "totalTrips": headers[m]["totalTrips"],
             "destinationCount": headers[m].get("destinationCount"),
             "complete": headers[m].get("destinationCount") == headers[m]["listed"]}
            if m in headers else {"month": m, "found": False}
            for m in months
        ],
        "destinations": destinations,
    }
