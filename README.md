# Yellow Cab Query (YCQ)

INF2003 Database Systems project. A web app for taxi fleet analysts built on
NYC TLC yellow taxi trip records, using PostgreSQL/PostGIS as the source of
truth and MongoDB for fast summaries and saved views.

This repo currently holds the database layer and the data pipeline. The
FastAPI backend (`api/`) and React frontend (`web/`) come next.

## Layout

```
docker-compose.yml   postgres (postgis/postgis:16-3.4) + mongo (mongo:8.0)
.env.example         copy to .env (git-ignored) and set passwords
data/                git-ignored, filled by scripts/download_data.py
scripts/             download_data.py
sql/                 numbered schema files, applied in order
etl/                 setup_db.py, load_zones.py, import_month.py,
                     build_aggregates.py, load_mongo.py, reconcile.py
```

## Setup

Needs Docker Desktop and Python 3.12+ (a normal CPython install; MSYS2/MinGW
Python can't install the Polars/psycopg wheels).

```bash
cp .env.example .env            # then change the passwords
docker compose up -d
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # .venv/bin/pip on macOS/Linux
```

## Loading a month

Run from the repo root (on Windows use `.venv\Scripts\python`):

```bash
python scripts/download_data.py --months 2026-01   # trips + zone lookup + shapefile, checks sha256
python etl/setup_db.py                              # schema, lookups, validation codes (safe to re-run)
python etl/load_zones.py                            # boroughs, zones, shapes (EPSG:2263 -> 4326)
python etl/import_month.py --month 2026-01          # staging -> trip / rejected_trip / trip_warning
python etl/build_aggregates.py --month 2026-01      # zone_hour_observation + od_summary
python etl/load_mongo.py --month 2026-01            # hourly time series + OD snapshots
python etl/reconcile.py --month 2026-01             # PostgreSQL vs MongoDB, stored in reconciliation_run
```

`import_month.py` refuses a file whose checksum was already imported (R5) and
runs the whole import in one transaction. `build_aggregates.py` and
`load_mongo.py` delete the month first, so running them twice gives the same
result.

## Import rules

Rejected rows go to `rejected_trip` with one reason (first rule that applies,
in this order: R1, R2, R3, R6, R4, then R7):

| Code | Rule |
|------|------|
| R1 | Pickup or drop-off time missing |
| R2 | Drop-off before pickup |
| R3 | Pickup outside the file's month |
| R6 | Trip longer than 24 hours |
| R4 | Pickup zone missing or has no map shape |
| R7 | Reversal: negative fare with a positive twin (same vendor, pickup time, pickup zone, drop-off zone, opposite fare). Paired one to one; the original is kept. |
| R5 | Whole file already imported (the import stops; no rows written) |

Accepted trips can carry warnings in `trip_warning` (one row per warning):

| Code | Rule | Left out of |
|------|------|-------------|
| W1 | Distance 0 or less | distance averages |
| W2 | Fare 0 or less | fare statistics |
| W3 | Distance over 100 miles | distance averages |
| W4 | Fare over $500 | fare statistics |
| W5 | Duration over 6 hours | duration averages |
| W6 | Drop-off zone missing or has no map shape (`geom IS NULL`) | drop-off counts and OD flows |
| W7 | Voided trip (payment type 6) | every summary |
| W8 | Implied speed over 80 mph (zero-second trips with distance count too) | distance and duration averages |

Fare statistics only use metered trips (payment type not 0 / Flex Fare) with a
fare above zero. Rate code 99 is stored as NULL.

## January 2026 results

| | |
|---|---|
| Rows read | 3,724,889 |
| Accepted | 3,683,870 |
| Rejected | 41,019 (R2 1, R3 7, R4 5,928, R6 35, R7 35,048) |
| Trips with warnings | 191,613 (W1 122,233, W2 6,353, W3 153, W4 47, W5 1,270, W6 18,807, W8 44,717) |
| zone_hour_observation rows | 195,672 (263 zones x 744 hours) |
| od_summary | 175,981 rows, 3,665,063 trips |
| MongoDB | 195,672 hourly docs, 2,478 OD snapshots |
| Reconciliation | passed (pickups 3,683,870, drop-offs 3,662,813) |

Drop-offs are lower than OD trips because 2,250 January trips end on 1 February;
those drop-offs belong to February's hourly grid.

## Notes

- MongoDB 8.0 does not allow a `$jsonSchema` validator on time-series
  collections. `origin_destination_snapshots` and `saved_analysis_views` have
  real validators; for `zone_activity_timeseries` the loader runs the same
  schema as a query after each load and removes the month if any document
  fails.
- MongoDB only allows updates on time-series collections that filter on the
  `meta` field. Deletes accept any filter, which is what the monthly rebuild
  uses.
