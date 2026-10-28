"""Activity Dashboard: the MongoDB pipelines in api/dashboard.py and the routes.

Uses the sample months from conftest (zones 1-3 in Manhattan). Every number
the pipelines give is checked against the same rows of zone_hour_observation
in PostgreSQL, which the MongoDB documents are built from.
"""
import sys

import pytest
from pydantic import ValidationError

from conftest import ROOT, login

sys.path.insert(0, str(ROOT))
from api import dashboard  # noqa: E402
from api.dashboard import ActivityFilters, CompareFilters, SeriesFilters  # noqa: E402

NAMES = {1: "Zone A", 2: "Zone B", 3: "Zone C"}
JANUARY = {"dateFrom": "2026-01-01", "dateTo": "2026-01-31"}


@pytest.fixture
def coll(mongo):
    return mongo[dashboard.COLLECTION]


def pg_totals(db, where="true", params=()):
    """Sums over zone_hour_observation, for comparing with MongoDB."""
    return db.execute(
        f"""SELECT coalesce(sum(pickups), 0)::int, coalesce(sum(dropoffs), 0)::int,
                   sum(fare_sum), sum(fare_trip_count)::int, count(DISTINCT local_date)::int
            FROM zone_hour_observation WHERE {where}""", params).fetchone()


# --- filters -------------------------------------------------------------------

def test_overnight_hours_wrap_round_midnight():
    assert dashboard.hours(ActivityFilters(hourFrom=22, hourTo=2)) == [22, 23, 0, 1, 2]
    assert dashboard.hours(ActivityFilters(hourFrom=8, hourTo=9)) == [8, 9]
    assert dashboard.hours(ActivityFilters(hourFrom=20)) == [20, 21, 22, 23]
    assert dashboard.hours(ActivityFilters()) is None


def test_match_leaves_out_unset_filters():
    assert dashboard.match(ActivityFilters()) == {"$match": {}}
    m = dashboard.match(ActivityFilters(dateFrom="2026-01-05", weekdays=[3, 1, 1],
                                        hourFrom=0, hourTo=23, boroughs=["Manhattan"], zoneIds=[2, 1]))
    assert m == {"$match": {"localDate": {"$gte": "2026-01-05"}, "isoDayOfWeek": {"$in": [1, 3]},
                            "meta.borough": {"$in": ["Manhattan"]}, "meta.zoneId": {"$in": [1, 2]}}}


@pytest.mark.parametrize("change", [
    {"dateFrom": "2026-02-30"},
    {"dateFrom": "January"},
    {"dateFrom": "2026-02-01", "dateTo": "2026-01-31"},
    {"weekdays": [0]},
    {"weekdays": [1, 2, 3, 4, 5, 6, 7, 1]},
    {"hourFrom": 24},
    {"zoneIds": [264]},
    {"zoneIds": [0]},
    {"boroughs": [""]},
    {"metric": "fares"},
    {"dateFrom": {"$gt": ""}},
    {"colour": "red"},
])
def test_bad_filters_are_refused(change):
    with pytest.raises(ValidationError):
        ActivityFilters.model_validate(change)


def test_compare_needs_one_to_three_zones():
    for zones in ([], [1, 2, 3, 4]):
        with pytest.raises(ValidationError):
            CompareFilters.model_validate({"zoneIds": zones})
    with pytest.raises(ValidationError):
        SeriesFilters.model_validate({"bucket": "week"})


# --- summary ---------------------------------------------------------------------

def test_summary_matches_postgres(coll, db):
    s = dashboard.summary(coll, ActivityFilters(), NAMES)
    pickups, dropoffs, fare_sum, fare_n, days = pg_totals(db)
    t = s["totals"]
    assert (t["pickups"], t["dropoffs"], t["days"], t["zones"]) == (pickups, dropoffs, days, 3)
    assert t["averageFare"] == round(float(fare_sum) / fare_n, 2)
    assert t["pickupsPerDay"] == round(pickups / days, 1)

    per_zone = dict(db.execute(
        "SELECT location_id, sum(pickups)::int FROM zone_hour_observation GROUP BY 1").fetchall())
    assert {z["zoneId"]: z["pickups"] for z in s["zones"]} == per_zone
    assert sum(z["pickupShare"] for z in s["zones"]) == pytest.approx(1, abs=0.001)


def test_summary_ranks_zones_and_names_them(coll):
    zones = dashboard.summary(coll, ActivityFilters(), NAMES)["zones"]
    assert [z["pickupRank"] for z in zones] == sorted(z["pickupRank"] for z in zones)
    assert zones[0]["zoneId"] == 1 and zones[0]["zoneName"] == "Zone A"   # most sample pickups
    assert all(z["imbalance"] == z["pickups"] - z["dropoffs"] for z in zones)
    by_dropoffs = sorted(zones, key=lambda z: z["dropoffRank"])
    assert [z["dropoffs"] for z in by_dropoffs] == sorted((z["dropoffs"] for z in zones), reverse=True)


def test_summary_filters(coll, db):
    # Mondays 8-9 AM in January, as the planner's sample uses.
    f = ActivityFilters(**JANUARY, weekdays=[1], hourFrom=8, hourTo=9, zoneIds=[1])
    t = dashboard.summary(coll, f, NAMES)["totals"]
    expected = pg_totals(db, """location_id = 1 AND iso_dow = 1 AND local_hour BETWEEN 8 AND 9
                                AND local_date BETWEEN '2026-01-01' AND '2026-01-31'""")
    assert (t["pickups"], t["dropoffs"], t["days"]) == (expected[0], expected[1], expected[4])
    assert t["pickups"] > 0


def test_nothing_matching_is_an_empty_answer(coll):
    s = dashboard.summary(coll, ActivityFilters(boroughs=["Queens"]), NAMES)
    assert s["zones"] == []
    assert s["totals"]["pickups"] == 0 and s["totals"]["averageFare"] is None


# --- series ----------------------------------------------------------------------

def test_daily_series_and_moving_average(coll, db):
    points = dashboard.series(coll, SeriesFilters(**JANUARY))["points"]
    daily = dict(db.execute(
        """SELECT local_date::text, sum(pickups)::int FROM zone_hour_observation
           WHERE local_date BETWEEN '2026-01-01' AND '2026-01-31' GROUP BY 1""").fetchall())
    assert [p["localDate"] for p in points] == sorted(daily)
    assert {p["localDate"]: p["pickups"] for p in points} == daily
    values = [p["pickups"] for p in points]
    for i, p in enumerate(points):
        window = values[max(0, i - 6): i + 1]
        assert p["movingAveragePickups"] == round(sum(window) / len(window), 1)


def test_hourly_series_keeps_the_23_hour_day_in_order(coll):
    points = dashboard.series(coll, SeriesFilters(dateFrom="2026-03-08", dateTo="2026-03-08",
                                                  bucket="hour"))["points"]
    assert [p["localHour"] for p in points] == [h for h in range(24) if h != 2]
    assert sum(p["pickups"] for p in points) == 2       # the two March sample trips


# --- weekdays --------------------------------------------------------------------

def test_weekday_averages_divide_by_days(coll, db):
    w = dashboard.weekdays(coll, ActivityFilters())
    expected = {dow: (days, pickups) for dow, days, pickups in db.execute(
        """SELECT iso_dow, count(DISTINCT local_date)::int, sum(pickups)::int
           FROM zone_hour_observation GROUP BY 1""").fetchall()}
    assert {r["isoDayOfWeek"]: (r["days"], r["pickups"]) for r in w["weekdays"]} == expected
    for r in w["weekdays"]:
        assert r["averagePickups"] == round(r["pickups"] / r["days"], 1)
    monday_8 = next(g for g in w["grid"] if g["isoDayOfWeek"] == 1 and g["hour"] == 8)
    assert monday_8["averagePickups"] == round(_monday_8(db), 1)
    assert len(w["grid"]) == 7 * 24


def _monday_8(db):
    total, days = db.execute(
        """SELECT sum(pickups), count(DISTINCT local_date) FROM zone_hour_observation
           WHERE iso_dow = 1 AND local_hour = 8""").fetchone()
    return float(total) / days


# --- zone comparison --------------------------------------------------------------

def test_compare_zones(coll, db):
    c = dashboard.compare_zones(coll, CompareFilters(zoneIds=[3, 1], **JANUARY), NAMES)
    assert [z["zoneId"] for z in c["zones"]] == [3, 1]          # the order asked for
    one = c["zones"][1]
    hourly = [p for (p,) in db.execute(
        """SELECT pickups FROM zone_hour_observation
           WHERE location_id = 1 AND local_date BETWEEN '2026-01-01' AND '2026-01-31'""")]
    assert one["hours"] == len(hourly) == 31 * 24
    assert one["pickups"] == sum(hourly)
    assert one["maxPickupsPerHour"] == max(hourly)
    assert one["medianPickupsPerHour"] == 0          # most sample hours have no trips
    assert one["peakHour"] == 8                      # zone 1's sample trips cluster at 8 AM
    assert one["meanPickupsPerHour"] == round(sum(hourly) / len(hourly), 2)


def test_compare_a_zone_with_no_hours(coll):
    c = dashboard.compare_zones(coll, CompareFilters(zoneIds=[2, 200]), NAMES)
    assert c["zones"][1] == {"zoneId": 200, "zoneName": "Zone 200", "found": False}


# --- pipelines are fixed -------------------------------------------------------------

def test_pipelines_take_only_values_from_the_client():
    f = ActivityFilters.model_validate({"weekdays": ["1"], "zoneIds": ["161"], "boroughs": ["$where"]})
    m = dashboard.match(f)["$match"]
    assert m["isoDayOfWeek"] == {"$in": [1]} and m["meta.zoneId"] == {"$in": [161]}
    assert m["meta.borough"] == {"$in": ["$where"]}     # a value, never an operator key


# --- routes --------------------------------------------------------------------------

def test_routes_through_the_api(client, make_user):
    make_user("ana@test.local", "analyst")
    headers = login(client, "ana@test.local")
    r = client.get("/dashboard?weekdays=1&weekdays=6&zoneIds=1&zoneIds=2&metric=imbalance",
                   headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["filters"]["weekdays"] == [1, 6]
    assert {z["zoneName"] for z in r.json()["zones"]} <= {"Zone A", "Zone B"}

    assert client.get("/dashboard/series?bucket=hour&dateFrom=2026-01-05&dateTo=2026-01-05",
                      headers=headers).json()["window"] == 24
    assert len(client.get("/dashboard/weekdays", headers=headers).json()["weekdays"]) == 7
    assert client.get("/dashboard/compare?zoneIds=1&zoneIds=2", headers=headers).status_code == 200

    for bad in ("/dashboard?hourFrom=25", "/dashboard?weekdays=9", "/dashboard?extra=1",
                "/dashboard/compare", "/dashboard/series?bucket=month"):
        assert client.get(bad, headers=headers).status_code == 422, bad


def test_context_route(client, db, make_user):
    user_id = make_user("ana@test.local", "analyst")
    db.execute("INSERT INTO allocation_plan (owner_user_id, name) VALUES (%s, 'Monday AM')", (user_id,))
    ctx = client.get("/dashboard/context", headers=login(client, "ana@test.local")).json()
    assert (ctx["dateFrom"], ctx["dateTo"]) == ("2026-01-01", "2026-03-31")
    assert ctx["latestImport"]["month"] in ("2026-01", "2026-02", "2026-03")
    assert [p["name"] for p in ctx["recentPlans"]] == ["Monday AM"]
