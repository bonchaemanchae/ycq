"""Flow Explorer queries on origin_destination_snapshots, and zone centroids.

Uses the sample months from conftest. Origin zone 1 on weekday mornings
(am_peak): January has 5 trips to zone 2 and 1 to zone 3, February 1 trip to
zone 2, March none. Zone 1's only weekend midday trip in January (row 20) has
an impossible speed (W8), so its distance and duration averages are null.
The sample data has no destination without a fare average, so the
`synthetic` fixture adds made-up snapshots for a month that is never loaded
or reconciled, and removes them afterwards.
"""
import sys

import pytest
from pydantic import ValidationError

from conftest import ROOT

sys.path.insert(0, str(ROOT))
from api import flows  # noqa: E402
from api.flows import CompareQuery, SliceQuery  # noqa: E402
from api.routers import zones  # noqa: E402

FAKE_MONTH = "2099-01"
GOOD = {"originZoneId": 1, "month": "2026-01", "dayType": "weekday", "timeBucket": "am_peak"}


def q(**changes):
    return SliceQuery(**{**GOOD, **changes})


def dest(rank, zone, trips, share, **changes):
    return {"rank": rank, "zoneId": zone, "zoneName": f"Zone {zone}", "borough": "Manhattan",
            "trips": trips, "share": round(share, 6), "averageFare": 10.0,
            "averageDistance": 1.5, "averageDurationSec": 600.0, **changes}


@pytest.fixture
def snapshots(mongo):
    return mongo[flows.COLLECTION]


@pytest.fixture
def synthetic(snapshots):
    snapshots.delete_many({"month": FAKE_MONTH})
    base = {"originZoneId": 1, "originBorough": "Manhattan", "month": FAKE_MONTH, "dayType": "weekday"}
    snapshots.insert_many([
        # no metered trips to zone 2, so no average fare
        {**base, "timeBucket": "night", "totalTrips": 4, "destinationCount": 1,
         "destinations": [dest(1, 2, 4, 1.0, averageFare=None)]},
        # destinations stored out of rank order
        {**base, "timeBucket": "evening", "totalTrips": 6, "destinationCount": 3,
         "destinations": [dest(3, 3, 1, 1 / 6), dest(1, 2, 3, 0.5), dest(2, 1, 2, 1 / 3)]},
    ])
    yield
    snapshots.delete_many({"month": FAKE_MONTH})


# --- one slice ---------------------------------------------------------------

def test_normal_slice(snapshots):
    s = flows.get_slice(snapshots, q())
    assert s["found"] is True and s["originBorough"] == "Manhattan"
    assert (s["totalTrips"], s["destinationCount"], s["topTrips"], s["topShare"]) == (6, 2, 6, 1.0)
    assert [(d["rank"], d["zoneId"], d["zoneName"], d["trips"], d["share"]) for d in s["destinations"]] == [
        (1, 2, "Zone B", 5, 0.833333), (2, 3, "Zone C", 1, 0.166667)]
    assert set(s["destinations"][0]) == set(flows.DEST_FIELDS)


def test_unwind_rows_follow_the_embedded_list(snapshots):
    rows = list(snapshots.aggregate(flows.slice_pipeline(q())))
    assert [r["position"] for r in rows] == [0, 1]
    assert all(r["rank"] == r["position"] + 1 and r["totalTrips"] == 6 for r in rows)


@pytest.mark.parametrize("changes", [
    {"month": "2026-03"},                           # zone 1 has no March weekday morning trips
    {"originZoneId": 2},                            # zone 2 has no weekday morning trips
    {"originZoneId": 263, "timeBucket": "night"},   # a valid zone with no trips at all
])
def test_missing_slice_is_an_empty_answer(snapshots, changes):
    s = flows.get_slice(snapshots, q(**changes))
    assert s["found"] is False and s["destinations"] == []
    assert (s["totalTrips"], s["topTrips"], s["topShare"]) == (0, 0, None)
    assert {k: s[k] for k in GOOD} == {**GOOD, **changes}


def test_null_distance_and_duration_averages(snapshots):
    s = flows.get_slice(snapshots, q(dayType="weekend", timeBucket="midday"))
    [d] = s["destinations"]
    assert d["zoneId"] == 2 and d["averageFare"] == 30.0
    assert d["averageDistance"] is None and d["averageDurationSec"] is None


def test_null_fare_average(snapshots, synthetic):
    [d] = flows.get_slice(snapshots, q(month=FAKE_MONTH, timeBucket="night"))["destinations"]
    assert d["averageFare"] is None and d["averageDistance"] == 1.5


def test_rows_are_sorted_by_rank_not_storage_order(snapshots, synthetic):
    s = flows.get_slice(snapshots, q(month=FAKE_MONTH, timeBucket="evening"))
    assert [(d["rank"], d["zoneId"]) for d in s["destinations"]] == [(1, 2), (2, 1), (3, 3)]
    assert s["topShare"] == 1.0


# --- months --------------------------------------------------------------------

def test_loaded_months(snapshots):
    # Deliberately without the synthetic fixture: its month must not be here.
    assert snapshots.count_documents({"month": FAKE_MONTH}) == 0
    assert flows.loaded_months(snapshots) == ["2026-01", "2026-02", "2026-03"]


def test_compare_months_merges_each_months_top_10(snapshots):
    c = flows.compare_months(snapshots, CompareQuery(originZoneId=1, dayType="weekday", timeBucket="am_peak"))
    assert c["basis"] == "each month's top 10 only"
    assert c["months"] == [
        {"month": "2026-01", "found": True, "totalTrips": 6, "destinationCount": 2, "complete": True},
        {"month": "2026-02", "found": True, "totalTrips": 1, "destinationCount": 1, "complete": True},
        {"month": "2026-03", "found": False},
    ]
    zone2, zone3 = c["destinations"]
    assert (zone2["zoneId"], zone2["monthsInTop10"], zone2["listedTrips"]) == (2, 2, 6)
    assert zone2["byMonth"] == {"2026-01": {"rank": 1, "trips": 5, "share": 0.833333},
                                "2026-02": {"rank": 1, "trips": 1, "share": 1.0},
                                "2026-03": None}
    # February's list is complete, so zone 3's missing entry there means 0 trips.
    assert (zone3["zoneId"], zone3["monthsInTop10"]) == (3, 1)
    assert zone3["byMonth"] == {"2026-01": {"rank": 2, "trips": 1, "share": 0.166667},
                                "2026-02": None, "2026-03": None}


# --- input checks ----------------------------------------------------------------

@pytest.mark.parametrize("change", [
    {"originZoneId": 0},
    {"originZoneId": 264},
    {"originZoneId": "abc"},
    {"originZoneId": {"$gt": 0}},
    {"month": "2026-13"},
    {"month": "2026-1"},
    {"month": "2026-01\n"},
    {"month": {"$gt": ""}},
    {"month": "$where"},
    {"dayType": "$ne"},
    {"dayType": "Weekday"},
    {"timeBucket": "rush_hour"},
    {"extra": "1"},
])
def test_bad_query_is_rejected(change):
    with pytest.raises(ValidationError):
        SliceQuery.model_validate({**GOOD, **change})


def test_compare_query_has_no_month():
    with pytest.raises(ValidationError):
        CompareQuery.model_validate(GOOD)


OPERATORS = {"$match", "$unwind", "$project", "$sort", "$facet", "$size", "$group", "$first", "$sum", "$push"}


def keys_and_strings(node, keys, strings):
    if isinstance(node, dict):
        for k, v in node.items():
            keys.add(k)
            keys_and_strings(v, keys, strings)
    elif isinstance(node, list):
        for v in node:
            keys_and_strings(v, keys, strings)
    elif isinstance(node, str):
        strings.add(node)


@pytest.mark.parametrize("pipeline", [
    # query-string values, as FastAPI hands them over
    flows.slice_pipeline(SliceQuery.model_validate({**GOOD, "originZoneId": "161"})),
    flows.compare_pipeline(CompareQuery.model_validate(
        {"originZoneId": "161", "dayType": "weekday", "timeBucket": "am_peak"})),
], ids=["slice", "compare"])
def test_pipelines_contain_no_client_operators(pipeline):
    keys, strings = set(), set()
    keys_and_strings(pipeline, keys, strings)
    assert {k for k in keys if k.startswith("$")} <= OPERATORS
    # every "$..." string is one of our field paths
    assert all(s in ("$destinations", "$month") or s.startswith("$destinations.")
               for s in strings if s.startswith("$"))
    match = pipeline[0]["$match"]
    assert match["originZoneId"] == 161 and type(match["originZoneId"]) is int
    assert all(type(v) in (int, str) and not str(v).startswith("$") for v in match.values())


# --- zone centroids --------------------------------------------------------------

def test_zone_centroids_are_inside_each_shape(db):
    rows = zones.zone_centroids(db)
    assert [r["location_id"] for r in rows] == [1, 2, 3]   # 264 and 265 have no shape
    for r in rows:
        # conftest draws zone N as the box lon N..N+1, lat 0..1
        assert r["location_id"] < r["lon"] < r["location_id"] + 1 and 0 < r["lat"] < 1
