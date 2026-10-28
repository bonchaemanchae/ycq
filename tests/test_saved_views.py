"""Saved views: owner-only CRUD on MongoDB, and the checks against PostgreSQL.

Uses the test zones from conftest: 1-3 in Manhattan with map shapes, 264
(Unknown) and 265 (N/A) without. Views belong to two test users and are
removed after each test.
"""
import sys
import time
from datetime import datetime, timezone

import pytest
from bson import ObjectId
from pydantic import ValidationError

from conftest import ROOT, login

sys.path.insert(0, str(ROOT))
from api import saved_views as sv  # noqa: E402
from api.filters import ActivityFilters  # noqa: E402

OWNER, OTHER = 9001, 9002

GOOD = {"name": "Morning peak", "page": "dashboard",
        "filters": {"dateFrom": "2026-01-01", "dateTo": "2026-01-31", "hourFrom": 6, "hourTo": 10,
                    "boroughs": ["Manhattan"], "zoneIds": [1, 2]}}
FLOWS = {"name": "Zone A mornings", "page": "flows",
         "filters": {"originZoneId": 1, "month": "2026-01", "dayType": "weekday", "timeBucket": "am_peak"}}


@pytest.fixture
def views(mongo, db):
    """The collection, with OWNER and OTHER as active users (a view can only
    be saved for one)."""
    db.execute("""INSERT INTO app_user (user_id, email, display_name, password_hash)
                  VALUES (%s, 'owner@test.local', 'Owner', '-'), (%s, 'other@test.local', 'Other', '-')
                  ON CONFLICT DO NOTHING""", (OWNER, OTHER))
    coll = mongo[sv.COLLECTION]
    coll.delete_many({"ownerUserId": {"$in": [OWNER, OTHER]}})
    yield coll
    coll.delete_many({"ownerUserId": {"$in": [OWNER, OTHER]}})
    db.execute("DELETE FROM app_user WHERE user_id IN (%s, %s)", (OWNER, OTHER))


def create(views, db, owner=OWNER, **changes):
    return sv.create_view(views, db, owner, sv.ViewCreate.model_validate({**GOOD, **changes}))


def test_create_and_get(views, db):
    v = create(views, db)
    assert isinstance(v["_id"], str)
    assert v["ownerUserId"] == OWNER and v["name"] == "Morning peak"
    assert v["createdAt"] == v["updatedAt"] and v["createdAt"].tzinfo is not None
    # What POST returns is exactly what GET reads back.
    assert sv.get_view(views, OWNER, v["_id"]) == v


def test_an_inactive_or_unknown_owner_cannot_save(views, db):
    db.execute("UPDATE app_user SET is_active = false WHERE user_id = %s", (OWNER,))
    for owner in (OWNER, 0):
        with pytest.raises(sv.ViewError, match="no longer active"):
            create(views, db, owner=owner)
        assert views.count_documents({"ownerUserId": owner}) == 0


def test_list_shows_only_own_views_newest_first(views, db):
    create(views, db, name="First")
    time.sleep(0.01)
    create(views, db, name="Second")
    create(views, db, owner=OTHER, name="Theirs")
    assert [v["name"] for v in sv.list_views(views, OWNER)] == ["Second", "First"]


def test_other_user_cannot_read_rename_or_delete(views, db):
    v = create(views, db)
    for call in (lambda: sv.get_view(views, OTHER, v["_id"]),
                 lambda: sv.rename_view(views, OTHER, v["_id"], "Mine now"),
                 lambda: sv.delete_view(views, OTHER, v["_id"])):
        with pytest.raises(sv.ViewNotFound):
            call()
    assert sv.get_view(views, OWNER, v["_id"]) == v


@pytest.mark.parametrize("view_id", ["nope", "", "0" * 23, str(ObjectId())])
def test_bad_or_missing_id_is_not_found(views, db, view_id):
    create(views, db)
    for call in (lambda: sv.get_view(views, OWNER, view_id),
                 lambda: sv.rename_view(views, OWNER, view_id, "New name"),
                 lambda: sv.delete_view(views, OWNER, view_id)):
        with pytest.raises(sv.ViewNotFound):
            call()


def test_duplicate_name_is_refused(views, db):
    create(views, db)
    with pytest.raises(sv.ViewNameTaken):
        create(views, db)
    with pytest.raises(sv.ViewNameTaken):
        create(views, db, name="  Morning peak  ")
    create(views, db, owner=OTHER)                      # another owner may use the name
    evening = create(views, db, name="Evening")
    with pytest.raises(sv.ViewNameTaken):
        sv.rename_view(views, OWNER, evening["_id"], "Morning peak")
    assert views.count_documents({"ownerUserId": OWNER}) == 2


def test_rename_updates_name_and_updated_at(views, db):
    v = create(views, db)
    time.sleep(0.01)
    renamed = sv.rename_view(views, OWNER, v["_id"], "  Renamed ")
    assert renamed["name"] == "Renamed"
    assert renamed["createdAt"] == v["createdAt"]
    assert renamed["updatedAt"] > v["updatedAt"]
    assert sv.get_view(views, OWNER, v["_id"]) == renamed


def test_delete_own_view(views, db):
    v = create(views, db)
    sv.delete_view(views, OWNER, v["_id"])
    with pytest.raises(sv.ViewNotFound):
        sv.get_view(views, OWNER, v["_id"])
    with pytest.raises(sv.ViewNotFound):
        sv.delete_view(views, OWNER, v["_id"])


@pytest.mark.parametrize("filters, message", [
    ({"zoneIds": [1, 4]}, "4"),              # a real zone id, but not in the test database
    ({"boroughs": ["Atlantis"]}, "Atlantis"),
    ({"boroughs": ["Unknown"]}, "Unknown"),  # exists, but no shaped zone
    ({"boroughs": ["N/A"]}, "N/A"),
])
def test_unknown_zone_or_borough_is_refused(views, db, filters, message):
    with pytest.raises(sv.ViewError, match=message):
        create(views, db, filters=filters)
    assert views.count_documents({"ownerUserId": OWNER}) == 0


@pytest.mark.parametrize("change", [
    {"colour": "red"},
    {"filters": {"originZoneId": 1}},
    {"filters": {"hourFrom": "8"}},
    {"filters": {"hourFrom": True}},
    {"filters": {"hourFrom": 24}},
    {"filters": {"zoneIds": [1.0]}},
    {"filters": {"zoneIds": ["1"]}},
    {"filters": {"zoneIds": [0]}},
    {"filters": {"zoneIds": [264]}},          # no map shape, so the dashboard can't show it
    {"filters": {"boroughs": [""]}},
    {"filters": {"weekdays": [0]}},
    {"filters": {"dateFrom": "January"}},
    {"filters": {"dateFrom": "2026-02-30"}},
    {"filters": {"dateFrom": "2026-02-01", "dateTo": "2026-01-31"}},
    {"filters": {"metric": "fares"}},
    {"page": "settings"},
    {"name": ""},
    {"name": "   "},
    {"name": "x" * 101},
    {"widgets": [1]},
])
def test_model_rejects_what_the_validator_would(change):
    with pytest.raises(ValidationError):
        sv.ViewCreate.model_validate({**GOOD, **change})


def test_page_is_required():
    with pytest.raises(ValidationError):
        sv.ViewCreate.model_validate({k: v for k, v in GOOD.items() if k != "page"})


def widgets_of_size(chars):
    widgets = {"x": "a" * (chars - sv.widgets_size({"x": ""}))}
    assert sv.widgets_size(widgets) == chars
    return widgets


@pytest.mark.parametrize("at_limit, over_limit, message", [
    ({"filters": {"zoneIds": list(range(1, 264))}},
     {"filters": {"zoneIds": [*range(1, 264), 1]}}, "at most 263 items"),
    ({"filters": {"boroughs": [f"Borough {i}" for i in range(10)]}},
     {"filters": {"boroughs": [f"Borough {i}" for i in range(11)]}}, "at most 10 items"),
    ({"filters": {"boroughs": ["b" * 50]}},
     {"filters": {"boroughs": ["b" * 51]}}, "at most 50 characters"),
    ({"filters": {"weekdays": [1, 2, 3, 4, 5, 6, 7]}},
     {"filters": {"weekdays": [1, 2, 3, 4, 5, 6, 7, 1]}}, "at most 7 items"),
    ({"widgets": widgets_of_size(10_000)},
     {"widgets": widgets_of_size(10_001)}, "10,001 characters as JSON; the limit is 10,000"),
], ids=["zoneIds", "boroughs", "borough-name", "weekdays", "widgets"])
def test_size_limits(at_limit, over_limit, message):
    sv.ViewCreate.model_validate({**GOOD, **at_limit})
    with pytest.raises(ValidationError, match=message):
        sv.ViewCreate.model_validate({**GOOD, **over_limit})


def test_every_field_passes_the_real_validator(views, db):
    v = create(views, db, page="dashboard",
               filters={"dateFrom": "2026-01-01", "dateTo": "2026-03-31", "weekdays": [1, 2, 3, 4, 5],
                        "hourFrom": 22, "hourTo": 2, "boroughs": ["Manhattan"],
                        "zoneIds": [1, 2, 3], "metric": "imbalance"},
               widgets={"map": {"zoom": 11}, "chart": None})
    assert sv.get_view(views, OWNER, v["_id"]) == v


def test_a_flow_explorer_view_holds_its_four_choices(views, db):
    v = create(views, db, **FLOWS, widgets={"compareMonths": True})
    assert v["filters"] == FLOWS["filters"] and v["widgets"] == {"compareMonths": True}
    assert sv.get_view(views, OWNER, v["_id"]) == v


@pytest.mark.parametrize("page, filters, message", [
    ("flows", {"originZoneId": 1, "month": "2026-01", "dayType": "weekday"}, "needs timeBucket"),
    ("flows", {**FLOWS["filters"], "boroughs": ["Manhattan"]}, "boroughs can't be saved on the flows page"),
    ("dashboard", {"originZoneId": 1}, "originZoneId can't be saved on the dashboard page"),
    ("dashboard", {"month": "2026-01", "dayType": "weekend"}, "dayType, month can't be saved"),
])
def test_a_view_holds_only_its_own_pages_filters(page, filters, message):
    with pytest.raises(ValidationError, match=message):
        sv.ViewCreate.model_validate({**GOOD, "page": page, "filters": filters})


def test_an_origin_zone_without_a_map_shape_is_refused(views, db):
    with pytest.raises(ValidationError):            # outside 1-263: the model refuses it
        sv.ViewCreate.model_validate({**FLOWS, "filters": {**FLOWS["filters"], "originZoneId": 264}})
    with pytest.raises(sv.ViewError, match="4"):    # in range, but not in the test database
        create(views, db, **{**FLOWS, "filters": {**FLOWS["filters"], "originZoneId": 4}})


def test_update_stores_new_filters_and_widgets_and_keeps_the_page(views, db):
    v = create(views, db)
    new = {"dateFrom": "2026-02-01", "dateTo": "2026-02-28", "weekdays": [6, 7], "metric": "dropoffs"}
    time.sleep(0.01)
    updated = sv.update_view(views, db, OWNER, v["_id"],
                             sv.ViewUpdate(filters=new, widgets={"compareZoneIds": [1, 3], "bucket": "hour"}))
    assert updated["filters"] == new and updated["page"] == "dashboard" and updated["name"] == v["name"]
    assert updated["widgets"] == {"compareZoneIds": [1, 3], "bucket": "hour"}
    assert updated["updatedAt"] > v["updatedAt"]
    assert sv.get_view(views, OWNER, v["_id"]) == updated


def test_update_is_held_to_the_views_page_and_the_database(views, db):
    v = create(views, db)
    with pytest.raises(sv.ViewError, match="can't be saved on the dashboard page"):
        sv.update_view(views, db, OWNER, v["_id"], sv.ViewUpdate(filters=FLOWS["filters"]))
    with pytest.raises(sv.ViewError, match="Atlantis"):
        sv.update_view(views, db, OWNER, v["_id"], sv.ViewUpdate(filters={"boroughs": ["Atlantis"]}))
    with pytest.raises(sv.ViewNotFound):
        sv.update_view(views, db, OTHER, v["_id"], sv.ViewUpdate(filters={}))
    with pytest.raises(ValidationError, match="nothing to change"):
        sv.ViewUpdate()
    assert sv.get_view(views, OWNER, v["_id"]) == v


def test_list_one_pages_views(views, db):
    create(views, db, name="Dash")
    create(views, db, **FLOWS)
    assert [v["name"] for v in sv.list_views(views, OWNER, "flows")] == ["Zone A mornings"]
    assert [v["name"] for v in sv.list_views(views, OWNER, "dashboard")] == ["Dash"]
    assert len(sv.list_views(views, OWNER)) == 2


def test_saved_filters_always_reopen_on_the_dashboard():
    """One definition (api/filters.py): whatever a view can store, the
    dashboard accepts, and gets the same filters back."""
    for filters in (GOOD["filters"], {}, {"hourFrom": 22, "hourTo": 2, "weekdays": [6, 7], "metric": "imbalance"}):
        saved = sv.ViewCreate.model_validate({**GOOD, "filters": filters}).filters.model_dump(exclude_none=True)
        assert ActivityFilters.model_validate(saved).model_dump(exclude_none=True) == {"metric": "pickups", **saved}


@pytest.mark.parametrize("filters", [
    {"zoneIds": [264]},
    {"zoneIds": [*range(1, 264), 1]},
    {"boroughs": [""]},
    {"boroughs": [f"Borough {i}" for i in range(11)]},
    {"weekdays": [8]},
    {"hourFrom": "8"},
    {"dateFrom": "5 January"},
    {"metric": "fares"},
    {"colour": "red"},
])
def test_mongodb_validator_enforces_the_same_filter_rules(views, filters):
    """The validator is generated from the model, so a write that skips the
    API is held to the same rules."""
    now = datetime.now(timezone.utc)
    with pytest.raises(sv.ViewError, match="rejected"):
        sv._insert(views, {"ownerUserId": OWNER, "name": "Raw", "page": "dashboard", "filters": filters,
                           "createdAt": now, "updatedAt": now})


def test_validator_rejection_becomes_a_view_error(views, db):
    now = datetime.now(timezone.utc)
    with pytest.raises(sv.ViewError, match="rejected"):
        sv._insert(views, {"ownerUserId": OWNER, "name": "Bad", "filters": {},
                           "createdAt": now, "updatedAt": now, "colour": "red"})
    # The rename path (findAndModify) reports validation differently.
    v = create(views, db)
    with pytest.raises(sv.ViewError, match="rejected"):
        sv.rename_view(views, OWNER, v["_id"], "   ")


def test_delete_views_for_user_only_removes_that_user(views, db):
    create(views, db, name="A")
    create(views, db, name="B")
    theirs = create(views, db, owner=OTHER, name="A")
    assert sv.delete_views_for_user(views, OWNER) == 2
    assert sv.list_views(views, OWNER) == []
    assert sv.list_views(views, OTHER) == [theirs]
    assert sv.delete_views_for_user(views, OWNER) == 0


# --- orphaned views ---------------------------------------------------------------

LOST = 987654     # no such user


def test_a_user_deleted_outside_the_app_leaves_orphans_that_are_found_and_deleted(views, db):
    create(views, db)
    create(views, db, owner=OTHER, name="Theirs")
    # Deleting the user straight in SQL skips the app's MongoDB step
    db.execute("DELETE FROM app_user WHERE user_id = %s", (OTHER,))
    now = datetime.now(timezone.utc)
    sv._insert(views, {"ownerUserId": LOST, "name": "Lost", "page": "dashboard", "filters": {},
                       "createdAt": now, "updatedAt": now})
    try:
        found = sv.orphaned_views(views, db)
        assert {OTHER, LOST} <= set(found["owners"]) and OWNER not in found["owners"]
        assert found["orphaned"] >= 2 and found["views"] >= 3
        assert sv.delete_orphaned_views(views, db) >= 2
        assert sv.orphaned_views(views, db)["orphaned"] == 0
        assert [v["name"] for v in sv.list_views(views, OWNER)] == ["Morning peak"]   # kept
    finally:
        views.delete_many({"ownerUserId": LOST})


def test_admin_checks_and_deletes_orphans_through_the_api(client, views, db, make_user):
    make_user("boss@test.local", "admin")
    admin = login(client, "boss@test.local")
    now = datetime.now(timezone.utc)
    sv._insert(views, {"ownerUserId": LOST, "name": "Lost", "page": "dashboard", "filters": {},
                       "createdAt": now, "updatedAt": now})
    try:
        r = client.get("/admin/orphaned-views", headers=admin)
        assert r.status_code == 200 and LOST in r.json()["owners"]
        assert client.delete("/admin/orphaned-views", headers=admin).json()["deleted"] >= 1
        assert client.get("/admin/orphaned-views", headers=admin).json()["orphaned"] == 0
    finally:
        views.delete_many({"ownerUserId": LOST})


# --- routes ------------------------------------------------------------------

def test_crud_through_the_api(client, views, make_user):
    """Create, read, update and delete, as the pages' Saved views panel does."""
    user_id = make_user("ana@test.local", "analyst")
    headers = login(client, "ana@test.local")
    try:
        r = client.post("/views", json=FLOWS, headers=headers)
        assert r.status_code == 201, r.text
        view_id = r.json()["_id"]
        assert client.post("/views", json=FLOWS, headers=headers).status_code == 409   # same name
        assert client.post("/views", json={**FLOWS, "page": "dashboard"}, headers=headers).status_code == 422

        listed = client.get("/views?page=flows", headers=headers).json()
        assert [v["_id"] for v in listed] == [view_id]
        assert client.get("/views?page=dashboard", headers=headers).json() == []
        assert client.get(f"/views/{view_id}", headers=headers).json()["filters"] == FLOWS["filters"]

        evening = {**FLOWS["filters"], "timeBucket": "evening"}
        r = client.patch(f"/views/{view_id}", json={"filters": evening, "name": "Zone A evenings"},
                         headers=headers)
        assert r.status_code == 200, r.text
        assert (r.json()["filters"], r.json()["name"]) == (evening, "Zone A evenings")
        assert client.patch(f"/views/{view_id}", json={}, headers=headers).status_code == 422

        other = make_user("bo@test.local", "analyst")
        assert client.get(f"/views/{view_id}", headers=login(client, "bo@test.local")).status_code == 404
        assert other != user_id

        assert client.delete(f"/views/{view_id}", headers=headers).status_code == 204
        assert client.get(f"/views/{view_id}", headers=headers).status_code == 404
    finally:
        views.delete_many({"ownerUserId": user_id})
