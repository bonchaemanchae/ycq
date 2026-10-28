"""The pages' filters, defined once.

The Activity Dashboard reads its filters from query parameters
(api/dashboard.py) and the Flow Explorer its choices (api/flows.py); a saved
view stores either page's (api/saved_views.py), and MongoDB's validator for
saved_analysis_views checks them (etl/load_mongo.py builds it with
mongo_schema below). One definition means a saved view always holds filters
its page accepts.

    ActivityFilters   the dashboard's query parameters: "8" becomes 8, the metric defaults to pickups
    SavedFilters      a saved view's JSON: either page's fields, types must already be right
    PAGE_FIELDS       which of SavedFilters' fields each page uses
    mongo_schema(SavedFilters)   the same rules as a MongoDB $jsonSchema

Imports nothing but Pydantic, so the ETL scripts can use it too.
"""
from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

IsoDate = Annotated[str, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")]
Hour = Annotated[int, Field(ge=0, le=23)]
Weekday = Annotated[int, Field(ge=1, le=7)]
ZoneId = Annotated[int, Field(ge=1, le=263)]       # 264 and 265 have no map shape
BoroughName = Annotated[str, Field(min_length=1, max_length=50)]
Metric = Literal["pickups", "dropoffs", "imbalance"]
Month = Annotated[str, Field(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")]
DayType = Literal["weekday", "weekend"]
# Local pickup hour: night 0-5, am_peak 6-9, midday 10-15, pm_peak 16-19, evening 20-23
TimeBucket = Literal["night", "am_peak", "midday", "pm_peak", "evening"]


class ActivityFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dateFrom: IsoDate | None = None
    dateTo: IsoDate | None = None
    weekdays: list[Weekday] | None = Field(None, max_length=7)
    hourFrom: Hour | None = None          # hourFrom > hourTo means overnight, e.g. 22 to 2
    hourTo: Hour | None = None
    boroughs: list[BoroughName] | None = Field(None, max_length=10)
    zoneIds: list[ZoneId] | None = Field(None, max_length=263)
    metric: Metric = "pickups"

    @field_validator("dateFrom", "dateTo")
    @classmethod
    def real_date(cls, v):
        if v is not None:
            try:
                date.fromisoformat(v)
            except ValueError:
                raise ValueError(f"{v} is not a real date") from None
        return v

    @model_validator(mode="after")
    def check(self):
        if self.dateFrom and self.dateTo and self.dateFrom > self.dateTo:
            raise ValueError("dateFrom must not be after dateTo")
        return self


class SavedFilters(ActivityFilters):
    """The filters of a saved view: the dashboard's, or the Flow Explorer's
    four choices (PAGE_FIELDS says which). Strict, because the JSON is stored
    as sent: without it "8" and true would become 8 and 1. The metric is only
    stored if it was chosen."""
    model_config = ConfigDict(extra="forbid", strict=True)

    metric: Metric | None = None
    originZoneId: ZoneId | None = None
    month: Month | None = None
    dayType: DayType | None = None
    timeBucket: TimeBucket | None = None


FLOW_FIELDS = {"originZoneId", "month", "dayType", "timeBucket"}
PAGE_FIELDS = {"dashboard": set(ActivityFilters.model_fields), "flows": FLOW_FIELDS}


def page_problem(page: str, filters: SavedFilters) -> str | None:
    """Why these filters can't be saved for this page, or None. A view must
    reopen its page as saved: no other page's fields, and a Flow Explorer
    view needs all four of its choices."""
    used = {f for f, v in filters if v is not None}
    if wrong := sorted(used - PAGE_FIELDS[page]):
        return f"{', '.join(wrong)} can't be saved on the {page} page"
    if page == "flows" and (missing := sorted(FLOW_FIELDS - used)):
        return f"a Flow Explorer view needs {', '.join(missing)}"
    return None


# --- as a MongoDB validator ------------------------------------------------------

BSON_TYPE = {"string": "string", "integer": "int", "array": "array"}
# JSON Schema keywords MongoDB's $jsonSchema understands the same way.
KEPT = {"pattern", "minimum", "maximum", "minLength", "maxLength", "maxItems", "enum"}


def _bson(field: dict) -> dict:
    # An optional field is anyOf [its type, null]. MongoDB stores no nulls
    # (an unset filter is left out), so only the real type is kept.
    (s,) = [option for option in field.get("anyOf", [field]) if option.get("type") != "null"]
    if unknown := set(s) - KEPT - {"type", "items", "title", "default"}:
        raise ValueError(f"no MongoDB equivalent for {sorted(unknown)}; extend api/filters.py")
    out = {"bsonType": BSON_TYPE[s["type"]], **{k: s[k] for k in KEPT if k in s}}
    if "items" in s:
        out["items"] = _bson(s["items"])
    return out


def mongo_schema(model: type[BaseModel]) -> dict:
    """The model's fields and limits as a MongoDB $jsonSchema object. Checks
    across fields (a real date, dateFrom before dateTo) stay in the model."""
    properties = model.model_json_schema()["properties"]
    return {"bsonType": "object", "additionalProperties": False,
            "properties": {name: _bson(p) for name, p in properties.items()}}
