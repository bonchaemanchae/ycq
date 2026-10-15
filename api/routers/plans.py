"""Allocation planner routes. The logic lives in api/planner.py."""
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from .. import planner
from ..auth import User, current_user
from ..db import get_pg

router = APIRouter(prefix="/plans", tags=["plans"])


class PlanSettings(BaseModel):
    fleet_size: int = Field(gt=0, le=100_000)
    iso_dow: int = Field(ge=1, le=7, description="1 = Monday")
    start_hour: int = Field(ge=0, le=23)
    end_hour: int = Field(ge=0, le=23, description="inclusive")
    borough_ids: list[int] = Field(min_length=1)
    max_zones_per_hour: int = Field(10, gt=0, le=263)
    min_sample: int = Field(30, ge=0)
    w_pickup: Decimal = Field(Decimal("0.50"), ge=0, le=1, decimal_places=3)
    w_imbalance: Decimal = Field(Decimal("0.25"), ge=0, le=1, decimal_places=3)
    w_consistency: Decimal = Field(Decimal("0.15"), ge=0, le=1, decimal_places=3)
    w_fare: Decimal = Field(Decimal("0.10"), ge=0, le=1, decimal_places=3)
    note: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def check(self):
        if self.start_hour > self.end_hour:
            raise ValueError("start_hour must not be after end_hour")
        if self.w_pickup + self.w_imbalance + self.w_consistency + self.w_fare != 1:
            raise ValueError("weights must add up to 1")
        return self

    def to_params(self) -> planner.PlanParams:
        return planner.PlanParams(**self.model_dump())


class Edit(BaseModel):
    hour: int = Field(ge=0, le=23)
    location_id: int
    final_taxis: int = Field(ge=0)


class SaveVersion(BaseModel):
    settings: PlanSettings
    edits: list[Edit] = []


class PlanName(BaseModel):
    name: str = Field(min_length=1, max_length=100)


def _http(e: Exception) -> HTTPException:
    if isinstance(e, planner.PlanNotFound):
        return HTTPException(404, str(e))
    return HTTPException(400, str(e))


@router.post("/preview")
def preview(settings: PlanSettings, conn=Depends(get_pg), user: User = Depends(current_user)):
    p = settings.to_params()
    rows = planner.score(conn, p)
    return {
        "allocations": [r for r in rows if r["selected"]],
        "empty_hours": planner.empty_hours(p, rows),
    }


@router.get("")
def list_plans(conn=Depends(get_pg), user: User = Depends(current_user)):
    return planner.list_plans(conn, user.user_id)


@router.post("", status_code=201)
def create_plan(body: PlanName, conn=Depends(get_pg), user: User = Depends(current_user)):
    try:
        return {"allocation_plan_id": planner.create_plan(conn, user.user_id, body.name)}
    except planner.PlanError as e:
        raise _http(e)


@router.patch("/{plan_id}")
def rename_plan(plan_id: int, body: PlanName, conn=Depends(get_pg),
                user: User = Depends(current_user)):
    try:
        planner.rename_plan(conn, user.user_id, plan_id, body.name)
    except (planner.PlanError, planner.PlanNotFound) as e:
        raise _http(e)
    return {"ok": True}


@router.delete("/{plan_id}", status_code=204)
def delete_plan(plan_id: int, conn=Depends(get_pg), user: User = Depends(current_user)):
    try:
        planner.delete_plan(conn, user.user_id, plan_id)
    except planner.PlanNotFound as e:
        raise _http(e)


@router.post("/{plan_id}/versions", status_code=201)
def save_version(plan_id: int, body: SaveVersion, conn=Depends(get_pg),
                 user: User = Depends(current_user)):
    edits = {(e.hour, e.location_id): e.final_taxis for e in body.edits}
    try:
        version_no = planner.save_version(conn, user.user_id, plan_id,
                                          body.settings.to_params(), edits)
    except (planner.PlanError, planner.PlanNotFound) as e:
        raise _http(e)
    return {"version_no": version_no}


@router.get("/{plan_id}/versions/{version_no}")
def get_version(plan_id: int, version_no: int, conn=Depends(get_pg),
                user: User = Depends(current_user)):
    try:
        return planner.get_version(conn, user.user_id, plan_id, version_no)
    except planner.PlanNotFound as e:
        raise _http(e)


@router.get("/{plan_id}/compare")
def compare(plan_id: int, from_version: int, to_version: int, conn=Depends(get_pg),
            user: User = Depends(current_user)):
    return planner.compare_versions(conn, user.user_id, plan_id, from_version, to_version)
