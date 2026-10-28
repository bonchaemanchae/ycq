"""Saved views: owner-only CRUD on MongoDB's saved_analysis_views.

Plain functions that take the collection (and a psycopg connection where
PostgreSQL has to be checked), so the FastAPI routes only parse the request,
call one of these and return the result.

    coll = mongo()["saved_analysis_views"]
    view = create_view(coll, conn, owner, ViewCreate(
        name="AM peak", page="flows",
        filters={"originZoneId": 161, "month": "2026-01", "dayType": "weekday", "timeBucket": "am_peak"}))
    rename_view(coll, owner, view["_id"], "Morning peak")
    update_view(coll, conn, owner, view["_id"], ViewUpdate(filters=...))   # the page's new filters

A view belongs to one page and holds only that page's filters
(filters.page_problem), so it always reopens as saved. Widgets hold the rest
of the page's layout in whatever shape the page likes (the dashboard's
compared zones, say); MongoDB stores it as given.

Every query includes ownerUserId, so someone else's view, a missing view and
a malformed id all look the same: ViewNotFound. The filters are
api/filters.py's SavedFilters, the same definition the dashboard uses; the
validator VIEWS_SCHEMA in etl/load_mongo.py is generated from it, and it and
the unique {ownerUserId, name} index still check every write.
"""
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

import psycopg
from bson import ObjectId
from bson.errors import InvalidId
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from pymongo import DESCENDING, ReturnDocument
from pymongo.collection import Collection
from pymongo.errors import DuplicateKeyError, OperationFailure

from .filters import SavedFilters, page_problem

COLLECTION = "saved_analysis_views"
VALIDATION_FAILED = 121   # MongoDB's DocumentValidationFailure


class ViewError(ValueError):
    """The view can't be saved as asked (shown to the user as a 422)."""


class ViewNameTaken(ViewError):
    """The owner already has a view with that name (shown as a 409)."""


class ViewNotFound(LookupError):
    """No such view, it belongs to someone else, or the id is malformed (a 404)."""


# --- request models (the rest of VIEWS_SCHEMA) ------------------------------

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
MAX_WIDGETS_CHARS = 10_000


def widgets_size(widgets: dict) -> int:
    """Characters in the widgets as compact JSON, roughly what MongoDB stores."""
    return len(json.dumps(widgets, separators=(",", ":"), ensure_ascii=False, default=str))


def check_widgets(widgets: dict | None) -> None:
    if widgets is not None and (size := widgets_size(widgets)) > MAX_WIDGETS_CHARS:
        raise ValueError(f"widgets is {size:,} characters as JSON; the limit is {MAX_WIDGETS_CHARS:,}")


class ViewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    page: Literal["dashboard", "flows"]   # optional in the validator, but needed to reopen a view
    filters: SavedFilters
    widgets: dict[str, Any] | None = None

    @model_validator(mode="after")
    def check(self):
        check_widgets(self.widgets)
        if problem := page_problem(self.page, self.filters):
            raise ValueError(problem)
        return self


class ViewUpdate(BaseModel):
    """A new name, new filters, new widgets, or any of them together. The
    page stays the one the view was saved for."""
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    filters: SavedFilters | None = None
    widgets: dict[str, Any] | None = None

    @model_validator(mode="after")
    def check(self):
        if self.name is None and self.filters is None and self.widgets is None:
            raise ValueError("nothing to change: send a name, filters or widgets")
        check_widgets(self.widgets)
        return self


# --- helpers -----------------------------------------------------------------

def _now() -> datetime:
    # MongoDB keeps milliseconds, so trimming here makes what POST returns
    # equal to what a later GET reads back.
    now = datetime.now(timezone.utc)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


def _oid(view_id: str) -> ObjectId:
    try:
        return ObjectId(view_id)
    except (InvalidId, TypeError):
        raise ViewNotFound("view not found") from None


def _out(doc: dict) -> dict:
    return {**doc, "_id": str(doc["_id"])}


@contextmanager
def _write_errors(name: str):
    """Turn the unique index and the validator's refusals into ViewErrors."""
    try:
        yield
    except DuplicateKeyError as e:            # a subclass of OperationFailure: check it first
        raise ViewNameTaken(f"you already have a view called {name!r}") from e
    except OperationFailure as e:
        if e.code != VALIDATION_FAILED:
            raise
        raise ViewError(f"the database rejected the view: {(e.details or {}).get('errmsg', e)}") from e


def _insert(coll: Collection, doc: dict) -> None:
    with _write_errors(doc.get("name", "")):
        coll.insert_one(doc)


def check_references(conn: psycopg.Connection, filters: SavedFilters) -> None:
    """MongoDB can't hold a foreign key into PostgreSQL, so check here that
    every zone exists and has a map shape (the rule the planner's
    allocation_result_zone trigger uses), and every borough has a shaped zone
    (the list GET /zones/boroughs offers)."""
    zones = [*(filters.zoneIds or []), *([filters.originZoneId] if filters.originZoneId else [])]
    if zones:
        found = {z for (z,) in conn.execute(
            "SELECT location_id FROM taxi_zone WHERE location_id = ANY(%s) AND geom IS NOT NULL",
            (zones,))}
        if unknown := sorted(set(zones) - found):
            raise ViewError(f"unknown zone id(s) or zones without a map shape: "
                            f"{', '.join(map(str, unknown))}")
    if filters.boroughs:
        found = {b for (b,) in conn.execute(
            """SELECT b.name FROM borough b
               WHERE b.name = ANY(%s)
                 AND EXISTS (SELECT 1 FROM taxi_zone z
                             WHERE z.borough_id = b.borough_id AND z.geom IS NOT NULL)""",
            (filters.boroughs,))}
        if unknown := sorted(set(filters.boroughs) - found):
            raise ViewError(f"unknown borough(s): {', '.join(unknown)}")


# --- CRUD --------------------------------------------------------------------

def list_views(coll: Collection, owner_user_id: int, page: str | None = None) -> list[dict]:
    """The owner's saved views, newest first; only one page's if `page` is given."""
    query = {"ownerUserId": owner_user_id, **({"page": page} if page else {})}
    return [_out(d) for d in coll.find(query).sort("updatedAt", DESCENDING)]


def get_view(coll: Collection, owner_user_id: int, view_id: str) -> dict:
    doc = coll.find_one({"_id": _oid(view_id), "ownerUserId": owner_user_id})
    if doc is None:
        raise ViewNotFound("view not found")
    return _out(doc)


def create_view(coll: Collection, conn: psycopg.Connection, owner_user_id: int,
                view: ViewCreate) -> dict:
    check_references(conn, view.filters)
    now = _now()
    doc = {
        "ownerUserId": owner_user_id,
        "name": view.name,
        "page": view.page,
        # Unset filters are left out: the validator refuses nulls.
        "filters": view.filters.model_dump(exclude_none=True),
        "createdAt": now,
        "updatedAt": now,
    }
    if view.widgets is not None:
        doc["widgets"] = view.widgets
    # Holding the owner's row until the view is stored makes a user deletion
    # (api/users.py) wait for this save and then delete the view with the rest;
    # once the deletion has deactivated the owner, no view can be saved.
    with conn.transaction():
        if conn.execute("SELECT 1 FROM app_user WHERE user_id = %s AND is_active FOR SHARE",
                        (owner_user_id,)).fetchone() is None:
            raise ViewError("your account is no longer active")
        _insert(coll, doc)
    return _out(doc)


def _set(coll: Collection, owner_user_id: int, view_id: str, fields: dict) -> dict:
    with _write_errors(fields.get("name", "")):
        doc = coll.find_one_and_update(
            {"_id": _oid(view_id), "ownerUserId": owner_user_id},
            {"$set": {**fields, "updatedAt": _now()}},
            return_document=ReturnDocument.AFTER,
        )
    if doc is None:
        raise ViewNotFound("view not found")
    return _out(doc)


def rename_view(coll: Collection, owner_user_id: int, view_id: str, name: str) -> dict:
    return _set(coll, owner_user_id, view_id, {"name": name.strip()})


def update_view(coll: Collection, conn: psycopg.Connection, owner_user_id: int, view_id: str,
                change: ViewUpdate) -> dict:
    """Rename a view, or store the page's current filters or widgets in it."""
    fields = {}
    if change.filters is not None:
        page = get_view(coll, owner_user_id, view_id).get("page")
        if page and (problem := page_problem(page, change.filters)):
            raise ViewError(problem)
        check_references(conn, change.filters)
        fields["filters"] = change.filters.model_dump(exclude_none=True)
    if change.widgets is not None:
        fields["widgets"] = change.widgets
    if change.name is not None:
        fields["name"] = change.name
    return _set(coll, owner_user_id, view_id, fields)


def delete_view(coll: Collection, owner_user_id: int, view_id: str) -> None:
    if not coll.delete_one({"_id": _oid(view_id), "ownerUserId": owner_user_id}).deleted_count:
        raise ViewNotFound("view not found")


def delete_views_for_user(coll: Collection, user_id: int) -> int:
    """Delete all of a user's views. Returns how many were deleted.

    When a user is deleted, call this FIRST and delete the PostgreSQL app_user
    after: PostgreSQL's cascade can't reach MongoDB, and the other order can
    leave orphaned views if the second step fails (review §3.2)."""
    return coll.delete_many({"ownerUserId": user_id}).deleted_count


# --- orphaned views ------------------------------------------------------------

def orphaned_views(coll: Collection, conn: psycopg.Connection) -> dict:
    """Saved views whose owner no longer exists in PostgreSQL. MongoDB can't
    hold a foreign key into PostgreSQL, so this check stands in for one: the
    app's own deletion removes a user's views first, but a user deleted
    straight in psql, or one database restored from a backup without the
    other, would leave views nobody can reach (review §3.2).

    Owners are read from MongoDB before PostgreSQL is asked, so a user created
    in between can't look missing."""
    owners = coll.distinct("ownerUserId")
    found = {u for (u,) in conn.execute("SELECT user_id FROM app_user WHERE user_id = ANY(%s)", (owners,))}
    missing = sorted(set(owners) - found)
    return {
        "views": coll.count_documents({}),
        "orphaned": coll.count_documents({"ownerUserId": {"$in": missing}}) if missing else 0,
        "owners": missing,
    }


def delete_orphaned_views(coll: Collection, conn: psycopg.Connection) -> int:
    """Delete the views orphaned_views finds. Returns how many."""
    missing = orphaned_views(coll, conn)["owners"]
    return coll.delete_many({"ownerUserId": {"$in": missing}}).deleted_count if missing else 0
