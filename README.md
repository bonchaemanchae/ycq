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

## Setup on a new machine

### 1. Install the tools (once per machine)

**Docker Desktop** runs both databases, so nobody installs PostgreSQL or MongoDB
by hand.

- Windows: open PowerShell as administrator and run `wsl --install`, restart,
  then run `winget install -e --id Docker.DockerDesktop`. Open Docker Desktop
  and wait until the bottom-left says "Engine running".
- macOS: install Docker Desktop from docker.com (pick Apple chip or Intel).

Check it works: `docker run hello-world`.

**Python 3.12 or newer** from python.org (Windows: `winget install -e --id
Python.Python.3.12`). Don't use the MSYS2/MinGW Python; it can't install the
Polars/psycopg wheels. On Windows, `py -0p` lists the Pythons you have.

**Git** (Windows: `winget install -e --id Git.Git`).

### 2. Get the code and start the databases

```bash
git clone <repo url> ycq
cd ycq
cp .env.example .env            # then change the passwords
docker compose up -d            # first run downloads the images (~1 GB)
py -3.12 -m venv .venv          # macOS/Linux: python3 -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # macOS/Linux: .venv/bin/pip
```

`data/` is not in git, so a fresh clone has no data until you run the steps
below. Each machine has its own databases, so every teammate loads the data
once (about 5 minutes per month).

Tip: keep the project folder outside OneDrive/iCloud. The `.venv` folder and
the parquet files are large and sync badly.

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

## Results (January to March 2026)

| | January | February | March |
|---|---:|---:|---:|
| Rows read | 3,724,889 | 3,399,866 | 3,952,451 |
| Accepted | 3,683,870 | 3,371,085 | 3,927,859 |
| Rejected | 41,019 | 28,781 | 24,592 |
| &nbsp;&nbsp;R2 / R3 / R4 / R6 | 1 / 7 / 5,928 / 35 | 2 / 16 / 5,021 / 37 | 2 / 19 / 6,249 / 28 |
| &nbsp;&nbsp;R7 reversals | 35,048 | 23,705 | 18,294 |
| Trips with warnings | 191,613 | 182,215 | 188,862 |
| &nbsp;&nbsp;W1 / W2 / W3 / W4 | 122,233 / 6,353 / 153 / 47 | 120,518 / 5,282 / 165 / 46 | 118,279 / 5,318 / 153 / 41 |
| &nbsp;&nbsp;W5 / W6 / W8 | 1,270 / 18,807 / 44,717 | 1,072 / 16,530 / 40,416 | 777 / 17,405 / 48,646 |
| zone_hour_observation rows | 195,672 (263 x 744) | 176,736 (263 x 672) | 195,409 (263 x 743, DST hour skipped) |
| od_summary trips | 3,665,063 | 3,354,555 | 3,910,454 |
| MongoDB OD snapshots | 2,478 | 2,483 | 2,491 |
| Reconciliation | passed | passed | passed |

No month has W7 (payment type 6) rows. Drop-offs are counted in the hour they
happen, so a trip that starts on the last evening of a month adds its drop-off
to the next month's grid (2,250 January trips end on 1 February).

January R7: 35,171 negative-fare rows have a positive twin. 123 of them were
already rejected for another reason (121 R4, 1 R3, 1 R6), along with their
twins, so 35,048 are recorded as R7. Every reversal is still rejected.

## Notes

- MongoDB 8.0 does not allow a `$jsonSchema` validator on time-series
  collections. `origin_destination_snapshots` and `saved_analysis_views` have
  real validators; for `zone_activity_timeseries` the loader runs the same
  schema as a query after each load and removes the month if any document
  fails.
- MongoDB only allows updates on time-series collections that filter on the
  `meta` field. Deletes accept any filter, which is what the monthly rebuild
  uses.
