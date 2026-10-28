"""Activity Dashboard: zone activity from MongoDB.

Plain functions that take a collection, so the FastAPI routes only parse the
filters, pick the collection with source(), call one of these and return the
result. All three collections are built from PostgreSQL's
zone_hour_observation by etl/load_mongo.py (zeros included) and share field
names, so every pipeline runs on any of them that has the fields it needs:

    zone_activity_timeseries   one zone, one New York local hour (568,000 docs
                               for three months)
    zone_activity_daily        one zone, one day (24 times fewer)
    borough_activity_hourly    one borough, one hour (about 44 times fewer)

Adding up fewer, pre-summed documents gives the same answer, measured 45 to
95 times faster on the three loaded months, so the page stays quick
whatever the date range.

    f = ActivityFilters(dateFrom="2026-01-01", dateTo="2026-01-31", boroughs=["Manhattan"])
    summary(coll, f, names)        # totals plus every zone, ranked ($facet, $setWindowFields)
    series(coll, SeriesFilters(bucket="day"))   # pickups per day, 7-day moving average
    weekdays(coll, f)              # per weekday, and weekday x hour averages
    compare_zones(coll, CompareFilters(zoneIds=[161, 237]), names)   # median, 90th percentile

Averages are always total sum / total count over the matching documents
(fareSum / fareTripCount and so on), never an average of hourly averages, so
they match what PostgreSQL gives for the same rows. The filters are defined
once in api/filters.py, shared with saved views, so a saved view can always
be reopened on this page.

Every value in a pipeline comes from a validated model field (ints, a fixed
list of names, dates matching YYYY-MM-DD); operator names are fixed here, so
nothing the client sends can become a MongoDB operator.
"""
from typing import Literal

from pydantic import Field
from pymongo.collection import Collection

from .filters import ActivityFilters, ZoneId

COLLECTION = "zone_activity_timeseries"
DAILY = "zone_activity_daily"
BOROUGH_HOURLY = "borough_activity_hourly"

# Moving-average window per series bucket: one day of hours, one week of days.
WINDOW = {"hour": 24, "day": 7}

SUMS = ("pickups", "dropoffs", "fareSum", "fareTripCount", "distanceSum",
        "distanceTripCount", "durationSumSec", "durationTripCount")


class SeriesFilters(ActivityFilters):
    bucket: Literal["hour", "day"] = "day"


class CompareFilters(ActivityFilters):
    zoneIds: list[ZoneId] = Field(min_length=1, max_length=3)


# --- pipeline pieces ---------------------------------------------------------

def hours(f: ActivityFilters) -> list[int] | None:
    """The local hours the filter keeps, or None for all 24."""
    if f.hourFrom is None and f.hourTo is None:
        return None
    start = 0 if f.hourFrom is None else f.hourFrom
    end = 23 if f.hourTo is None else f.hourTo
    if start <= end:
        return list(range(start, end + 1))
    return list(range(start, 24)) + list(range(0, end + 1))


def match(f: ActivityFilters) -> dict:
    """The $match stage for the filters. Empty lists mean no restriction."""
    m: dict = {}
    if f.dateFrom or f.dateTo:
        m["localDate"] = {}
        if f.dateFrom:
            m["localDate"]["$gte"] = f.dateFrom
        if f.dateTo:
            m["localDate"]["$lte"] = f.dateTo
    if f.weekdays:
        m["isoDayOfWeek"] = {"$in": sorted(set(f.weekdays))}
    if (h := hours(f)) is not None and len(h) < 24:
        m["localHour"] = {"$in": h}
    if f.boroughs:
        m["meta.borough"] = {"$in": sorted(set(f.boroughs))}
    if f.zoneIds:
        m["meta.zoneId"] = {"$in": sorted(set(f.zoneIds))}
    return {"$match": m}


def source(question: Literal["summary", "series", "weekdays", "compare"], f: ActivityFilters) -> str:
    """The smallest collection holding everything a question and its filters
    need:

    summary    per zone, so the daily documents, unless hours are filtered
    series,    per hour or day across zones, so the borough-hour documents,
    weekdays   unless particular zones are picked
    compare    per zone and hour (median busy hour), so always the hourly ones
    """
    hour_filter = (h := hours(f)) is not None and len(h) < 24
    if question == "summary" and not hour_filter:
        return DAILY
    if question in ("series", "weekdays") and not f.zoneIds:
        return BOROUGH_HOURLY
    return COLLECTION


def _sum_fields() -> dict:
    return {s: {"$sum": f"${s}"} for s in SUMS}


def _ratio(total, count, places=2):
    return round(float(total) / count, places) if count else None


def _averages(row: dict) -> dict:
    """Average fare, distance and duration from a row of sums."""
    return {
        "averageFare": _ratio(row["fareSum"], row["fareTripCount"]),
        "averageDistance": _ratio(row["distanceSum"], row["distanceTripCount"]),
        "averageDurationSec": _ratio(row["durationSumSec"], row["durationTripCount"], 1),
    }


def summary_pipeline(f: ActivityFilters) -> list[dict]:
    """Totals and one row per zone. The hourly documents are read once, into
    one row per zone; $facet then builds the totals and the ranked zone list
    from those rows. Rank and share come from $setWindowFields, so the share
    is out of every matching zone, not just the ones shown."""
    return [
        match(f),
        {"$group": {"_id": "$meta.zoneId", "borough": {"$first": "$meta.borough"},
                    **_sum_fields(), "days": {"$addToSet": "$localDate"}}},
        {"$facet": {
            "days": [
                {"$unwind": "$days"},
                {"$group": {"_id": "$days"}},
                {"$count": "days"},
            ],
            "totals": [
                {"$group": {"_id": None, **_sum_fields(), "zones": {"$sum": 1}}},
                {"$project": {"_id": 0}},
            ],
            "zones": [
                {"$project": {"days": 0}},
                {"$set": {"imbalance": {"$subtract": ["$pickups", "$dropoffs"]}}},
                {"$setWindowFields": {
                    "sortBy": {"pickups": -1},
                    "output": {
                        "pickupRank": {"$rank": {}},
                        "allPickups": {"$sum": "$pickups",
                                       "window": {"documents": ["unbounded", "unbounded"]}},
                    },
                }},
                {"$setWindowFields": {
                    "sortBy": {"dropoffs": -1},
                    "output": {
                        "dropoffRank": {"$rank": {}},
                        "allDropoffs": {"$sum": "$dropoffs",
                                        "window": {"documents": ["unbounded", "unbounded"]}},
                    },
                }},
                {"$sort": {"pickupRank": 1, "_id": 1}},
            ],
        }},
    ]


def series_pipeline(f: SeriesFilters) -> list[dict]:
    """City-wide (or filtered) totals per hour or per day, oldest first, with a
    moving average of pickups over this point and the previous ones
    (24 hours or 7 days). Hours are grouped by their UTC instant, so the
    23-hour day in March stays in order."""
    window = WINDOW[f.bucket] - 1
    if f.bucket == "hour":
        key = {"$group": {"_id": "$timestamp", "localDate": {"$first": "$localDate"},
                          "localHour": {"$first": "$localHour"}, **_sum_fields()}}
    else:
        key = {"$group": {"_id": "$localDate", "localDate": {"$first": "$localDate"},
                          **_sum_fields()}}
    return [
        match(f),
        key,
        {"$setWindowFields": {
            "sortBy": {"_id": 1},
            "output": {
                "movingAveragePickups": {"$avg": "$pickups", "window": {"documents": [-window, 0]}},
                "movingAverageDropoffs": {"$avg": "$dropoffs", "window": {"documents": [-window, 0]}},
            },
        }},
        {"$sort": {"_id": 1}},
    ]


def weekday_pipeline(f: ActivityFilters) -> list[dict]:
    """Average pickups per day for each weekday, and for each weekday and
    hour. Days are counted from the matching documents, so a filter that
    leaves out some dates still divides by the right number of days."""
    return [
        match(f),
        # One pass over the hourly documents: one row per date and hour.
        {"$group": {"_id": {"dow": "$isoDayOfWeek", "date": "$localDate", "hour": "$localHour"},
                    "pickups": {"$sum": "$pickups"}, "dropoffs": {"$sum": "$dropoffs"}}},
        {"$facet": {
            "weekdays": [
                {"$group": {"_id": {"dow": "$_id.dow", "date": "$_id.date"},
                            "pickups": {"$sum": "$pickups"}, "dropoffs": {"$sum": "$dropoffs"}}},
                {"$group": {"_id": "$_id.dow", "days": {"$sum": 1},
                            "pickups": {"$sum": "$pickups"}, "dropoffs": {"$sum": "$dropoffs"},
                            "averagePickups": {"$avg": "$pickups"},
                            "averageDropoffs": {"$avg": "$dropoffs"}}},
                {"$sort": {"_id": 1}},
            ],
            "grid": [
                {"$group": {"_id": {"dow": "$_id.dow", "hour": "$_id.hour"},
                            "averagePickups": {"$avg": "$pickups"}}},
                {"$sort": {"_id.dow": 1, "_id.hour": 1}},
            ],
        }},
    ]


def compare_pipeline(f: CompareFilters) -> list[dict]:
    """One to three zones side by side. Besides totals, the typical busy hour
    is described with the median and 90th percentile of hourly pickups, and
    each zone's peak hour is the hour of day with the most pickups on average."""
    return [
        match(f),
        {"$facet": {
            "stats": [
                {"$group": {"_id": "$meta.zoneId", "borough": {"$first": "$meta.borough"},
                            **_sum_fields(),
                            "hours": {"$sum": 1},
                            "meanPickupsPerHour": {"$avg": "$pickups"},
                            "medianPickupsPerHour": {"$median": {"input": "$pickups",
                                                                 "method": "approximate"}},
                            "p90PickupsPerHour": {"$percentile": {"input": "$pickups", "p": [0.9],
                                                                  "method": "approximate"}},
                            "maxPickupsPerHour": {"$max": "$pickups"}}},
                {"$sort": {"_id": 1}},
            ],
            "peak": [
                {"$group": {"_id": {"zone": "$meta.zoneId", "hour": "$localHour"},
                            "averagePickups": {"$avg": "$pickups"}}},
                # Busiest hour first, earliest hour on a tie, then keep one per zone.
                {"$sort": {"_id.zone": 1, "averagePickups": -1, "_id.hour": 1}},
                {"$group": {"_id": "$_id.zone", "hour": {"$first": "$_id.hour"},
                            "averagePickups": {"$first": "$averagePickups"}}},
            ],
        }},
    ]


# --- queries -------------------------------------------------------------------

def _name(names: dict, zone: int) -> str:
    return names.get(zone, f"Zone {zone}")


def summary(coll: Collection, f: ActivityFilters, names: dict[int, str]) -> dict:
    """Totals and every zone for the map, the ranked table and the top lists.
    `names` maps location_id to zone name (from PostgreSQL)."""
    facet = next(coll.aggregate(summary_pipeline(f)))
    t = facet["totals"][0] if facet["totals"] else None
    if t:
        t["days"] = facet["days"][0]["days"]
    totals = {
        "pickups": t["pickups"] if t else 0,
        "dropoffs": t["dropoffs"] if t else 0,
        "days": t["days"] if t else 0,
        "zones": t["zones"] if t else 0,
        "pickupsPerDay": _ratio(t["pickups"], t["days"], 1) if t else None,
        **(_averages(t) if t else {"averageFare": None, "averageDistance": None,
                                   "averageDurationSec": None}),
    }
    zones = []
    for z in facet["zones"]:
        zones.append({
            "zoneId": z["_id"],
            "zoneName": _name(names, z["_id"]),
            "borough": z["borough"],
            "pickups": z["pickups"],
            "dropoffs": z["dropoffs"],
            "imbalance": z["imbalance"],
            "pickupRank": z["pickupRank"],
            "dropoffRank": z["dropoffRank"],
            "pickupShare": _ratio(z["pickups"], z["allPickups"], 4),
            "dropoffShare": _ratio(z["dropoffs"], z["allDropoffs"], 4),
            **_averages(z),
        })
    return {"filters": f.model_dump(exclude_none=True), "totals": totals, "zones": zones}


def series(coll: Collection, f: SeriesFilters) -> dict:
    """Pickups and drop-offs per hour or day, with moving averages."""
    points = []
    for p in coll.aggregate(series_pipeline(f)):
        point = {"localDate": p["localDate"]}
        if f.bucket == "hour":
            point["localHour"] = p["localHour"]
        point.update({
            "pickups": p["pickups"],
            "dropoffs": p["dropoffs"],
            "movingAveragePickups": round(p["movingAveragePickups"], 1),
            "movingAverageDropoffs": round(p["movingAverageDropoffs"], 1),
            "averageFare": _ratio(p["fareSum"], p["fareTripCount"]),
        })
        points.append(point)
    return {"bucket": f.bucket, "window": WINDOW[f.bucket], "points": points}


def weekdays(coll: Collection, f: ActivityFilters) -> dict:
    facet = next(coll.aggregate(weekday_pipeline(f)))
    return {
        "weekdays": [{"isoDayOfWeek": w["_id"], "days": w["days"],
                      "pickups": w["pickups"], "dropoffs": w["dropoffs"],
                      "averagePickups": round(w["averagePickups"], 1),
                      "averageDropoffs": round(w["averageDropoffs"], 1)}
                     for w in facet["weekdays"]],
        "grid": [{"isoDayOfWeek": g["_id"]["dow"], "hour": g["_id"]["hour"],
                  "averagePickups": round(g["averagePickups"], 1)}
                 for g in facet["grid"]],
    }


def compare_zones(coll: Collection, f: CompareFilters, names: dict[int, str]) -> dict:
    """The chosen zones, in the order asked for. A zone with no matching hours
    comes back with found=False."""
    facet = next(coll.aggregate(compare_pipeline(f)))
    stats = {s["_id"]: s for s in facet["stats"]}
    peak = {p["_id"]: p for p in facet["peak"]}
    zones = []
    for zone in dict.fromkeys(f.zoneIds):          # keeps the order, drops repeats
        s = stats.get(zone)
        if s is None:
            zones.append({"zoneId": zone, "zoneName": _name(names, zone), "found": False})
            continue
        p = peak.get(zone)
        zones.append({
            "zoneId": zone,
            "zoneName": _name(names, zone),
            "borough": s["borough"],
            "found": True,
            "hours": s["hours"],
            "pickups": s["pickups"],
            "dropoffs": s["dropoffs"],
            "imbalance": s["pickups"] - s["dropoffs"],
            "meanPickupsPerHour": round(s["meanPickupsPerHour"], 2),
            "medianPickupsPerHour": s["medianPickupsPerHour"],
            "p90PickupsPerHour": s["p90PickupsPerHour"][0],
            "maxPickupsPerHour": s["maxPickupsPerHour"],
            "peakHour": p["hour"] if p else None,
            "peakHourAveragePickups": round(p["averagePickups"], 1) if p else None,
            **_averages(s),
        })
    return {"filters": f.model_dump(exclude_none=True), "zones": zones}
