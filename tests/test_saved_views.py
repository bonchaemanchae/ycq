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

from conftest import ROOT

sys.path.insert(0, str(ROOT))
from api import saved_views as sv  # noqa: E402

OWNER, OTHER = 9001, 9002

GOOD = {"name": "Morning peak", "page": "dashboard",
        "filters": {"dateFrom": "2026-01-01", "dateTo": "2026-01-31", "hourFrom": 6, "hourTo": 10,
                    "boroughs": ["Manhattan"], "zoneIds": [1, 2]}}


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
    ({"zoneIds": [1, 4]}, "4"),
    ({"zoneIds": [999]}, "999"),
    ({"zoneIds": [264]}, "264"),            # exists, but has no map shape
    ({"zoneIds": [265]}, "265"),
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
     {"filters": {"zoneIds": list(range(1, 265))}}, "at most 263 items"),
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
    v = create(views, db, page="flows",
               filters={"dateFrom": "2026-01-01", "dateTo": "2026-03-31", "weekdays": [1, 2, 3, 4, 5],
                        "hourFrom": 22, "hourTo": 2, "boroughs": ["Manhattan"],
                        "zoneIds": [1, 2, 3], "metric": "imbalance"},
               widgets={"map": {"zoom": 11}, "chart": None})
    assert sv.get_view(views, OWNER, v["_id"]) == v


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
