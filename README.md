# Yellow Cab Query (YCQ)

A web app for taxi fleet analysts, built on the official NYC Taxi and Limousine
Commission (TLC) yellow taxi trip records for January to March 2026. Analysts
see pickup and drop-off activity on a zone map, explore where passengers go,
and build hourly plans for where to place a fleet of taxis.

INF2003 Database Systems group project.

> YCQ uses historical completed-trip activity. Its allocation results are
> planning scenarios and do not represent live taxi availability, unmet
> passenger demand or guaranteed earnings.

## Contents

- [How it fits together](#how-it-fits-together)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Loading the data](#loading-the-data)
- [Import rules](#import-rules)
- [Results](#results-january-to-march-2026)
- [Working on the project](#working-on-the-project)
- [Troubleshooting](#troubleshooting)

## How it fits together

| Part | Technology | Job |
|---|---|---|
| Relational database | PostgreSQL 16 + PostGIS (`postgis/postgis:16-3.4`) | Source of truth: every trip, zones and shapes, users, plans, import history |
| NoSQL database | MongoDB 8.0 (`mongo:8.0`) | Fast hourly zone summaries, origin-destination snapshots, saved views |
| Data pipeline | Python, Polars, psycopg, PyMongo | Download, validate and import TLC files, build summaries, reconcile |
| Backend | FastAPI | *(next)* |
| Frontend | React + Vite, React Leaflet, Recharts | *(next)* |

```
TLC files ──> import_month.py ──> PostgreSQL ──> build_aggregates.py ──> load_mongo.py ──> MongoDB
               (sort rows into      trip,           zone_hour_observation,                  zone_activity_timeseries,
                accepted/rejected,  rejected_trip,  od_summary                              origin_destination_snapshots
                record warnings)    trip_warning
                                                     reconcile.py checks both databases match
```

PostgreSQL is always right: MongoDB's summaries can be deleted and rebuilt from
it at any time, one month at a time.

## Repository layout

```
docker-compose.yml   PostgreSQL + PostGIS and MongoDB containers
.env.example         copy to .env and set passwords (.env is never committed)
requirements.txt     Python packages for the pipeline
scripts/
  download_data.py   fetches TLC trip files, zone lookup and shapefile; checks sha256
sql/                 schema, applied in number order by etl/setup_db.py
  001_zones.sql        borough, taxi_zone (PostGIS shapes)
  002_lookups.sql      vendor, payment_type, rate_code, validation_code
  003_users.sql        app_user, app_role, app_user_role
  004_trips.sql        import_batch, trip_staging, trip (monthly partitions), trip_warning, rejected_trip
  005_summaries.sql    zone_hour_observation, od_summary (materialised view)
  006_plans.sql        allocation plans, versions, results, hourly-total trigger, v_plan_summary
  007_admin.sql        reconciliation_run, benchmark_run
  008_w9_...sql        W9 warning (drop-off time not recorded)
etl/
  setup_db.py          applies sql/ (safe to re-run)
  load_zones.py        boroughs, zones and shapes
  import_month.py      imports one month
  build_aggregates.py  hourly zone grid and origin-destination flows
  load_mongo.py        copies a month's summaries into MongoDB
  reconcile.py         checks PostgreSQL and MongoDB agree
data/                downloaded files (not in git)
```

## Getting started

### 1. Install the tools (once per machine)

| Tool | Windows | macOS |
|---|---|---|
| WSL (Docker needs it) | PowerShell **as administrator**: `wsl --install`, then restart | not needed |
| Docker Desktop | `winget install -e --id Docker.DockerDesktop` | download from docker.com (Apple chip or Intel) |
| Python 3.12+ | `winget install -e --id Python.Python.3.12` | `brew install python@3.12` or python.org |
| Git | `winget install -e --id Git.Git` | `xcode-select --install` |

Open Docker Desktop and wait until it says **Engine running**, then check:

```bash
docker run hello-world
```

On Windows, use the `py` launcher for Python. Other Pythons on the PATH (for
example MSYS2/MinGW) can't install Polars or psycopg. `py -0p` lists what you have.

### 2. Get the code and start the databases

```bash
git clone https://github.com/bonchaemanchae/ycq.git
cd ycq
cp .env.example .env          # then open .env and set your own passwords
docker compose up -d          # first run downloads the images (~1 GB)
```

`docker compose ps` should show both containers as `healthy`.

### 3. Set up Python

Windows (PowerShell):

```powershell
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Keep the project folder **outside OneDrive, iCloud or Dropbox**. The data files
and `.venv` are large, and syncing them can lock files mid-import.

## Loading the data

With the virtual environment active, from the repo root:

```bash
python scripts/download_data.py --months 2026-01 2026-02 2026-03
python etl/setup_db.py
python etl/load_zones.py
```

Then for each month (`2026-01`, `2026-02`, `2026-03`):

```bash
python etl/import_month.py     --month 2026-01
python etl/build_aggregates.py --month 2026-01
python etl/load_mongo.py       --month 2026-01
python etl/reconcile.py        --month 2026-01
```

Each month takes about 5 minutes. `reconcile.py` must print **PASSED**, and your
counts should match the [results table](#results-january-to-march-2026) exactly.

Good to know:

- `download_data.py` checks each file's SHA-256 against the known value and
  stops if a file differs.
- `import_month.py` runs the whole import in one transaction and refuses a file
  that was already imported (R5), so running it twice is harmless.
- `build_aggregates.py` and `load_mongo.py` delete the month before inserting,
  so running them again gives the same result.
- To start completely fresh: `docker compose down -v` (deletes both databases),
  then `docker compose up -d` and load again.

## Import rules

Every row is either **accepted** into `trip` or **rejected** into
`rejected_trip` with one reason code (the first rule that applies, checked in
the order R1, R2, R3, R6, R4, R7):

| Code | Rejected when |
|---|---|
| R1 | Pickup or drop-off time missing |
| R2 | Drop-off before pickup |
| R3 | Pickup outside the file's month |
| R6 | Trip longer than 24 hours |
| R4 | Pickup zone missing or has no map shape (zones 264, 265) |
| R7 | Reversal: a negative fare with a positive twin (same vendor, pickup time, pickup zone, drop-off zone, opposite fare). Paired one to one; the original is kept |
| R5 | Whole file already imported (the import stops and writes nothing) |

Accepted trips can carry warnings in `trip_warning` (one row per warning). A
warned trip stays in `trip` but is left out of the averages it would distort:

| Code | Warning | Left out of |
|---|---|---|
| W1 | Distance 0 or less (often a Flex Fare trip with no distance recorded) | distance averages |
| W2 | Fare 0 or less | fare statistics |
| W3 | Distance over 100 miles | distance averages |
| W4 | Fare over $500 | fare statistics |
| W5 | Duration over 6 hours | duration averages |
| W6 | Drop-off zone missing or has no map shape | drop-off counts and flows |
| W7 | Voided trip (payment type 6) | every summary |
| W8 | Implied speed over 80 mph (trips with a real duration) | distance and duration averages |
| W9 | Drop-off time not recorded (same as pickup time; vendor 7 sends every trip this way) | duration averages |

Other rules: fare statistics use metered trips only (not payment type 0, Flex
Fare) with a fare above zero; rate code 99 (unknown) is stored as NULL; times
stay in New York local time, and the hourly grid follows the real clock (8 March
2026 has 23 hours).

## Results (January to March 2026)

Official TLC files, checked by SHA-256 (first 16 characters):
`8b3933fe6f0d7b6d` (Jan), `5352ca800f29c40a` (Feb), `d7af794a7ac06cbb` (Mar).

| | January | February | March |
|---|---:|---:|---:|
| Rows read | 3,724,889 | 3,399,866 | 3,952,451 |
| Accepted | 3,683,870 | 3,371,085 | 3,927,859 |
| Rejected | 41,019 | 28,781 | 24,592 |
| R2 / R3 / R4 / R6 | 1 / 7 / 5,928 / 35 | 2 / 16 / 5,021 / 37 | 2 / 19 / 6,249 / 28 |
| R7 reversals | 35,048 | 23,705 | 18,294 |
| Trips with warnings | 191,613 | 182,215 | 188,862 |
| W1 / W2 / W3 / W4 | 122,233 / 6,353 / 153 / 47 | 120,518 / 5,282 / 165 / 46 | 118,279 / 5,318 / 153 / 41 |
| W5 / W6 | 1,270 / 18,807 | 1,072 / 16,530 | 777 / 17,405 |
| W8 / W9 | 828 / 45,022 | 730 / 40,550 | 1,092 / 49,072 |
| Zone-hour rows | 195,672 (263 × 744) | 176,736 (263 × 672) | 195,409 (263 × 743) |
| Origin-destination trips | 3,665,063 | 3,354,555 | 3,910,454 |
| MongoDB OD snapshots | 2,478 | 2,483 | 2,491 |
| Reconciliation | passed | passed | passed |

No month has voided trips (W7). In January, 35,171 negative-fare rows have a
positive twin; 123 of them already fail an earlier rule (121 R4, 1 R3, 1 R6),
so 35,048 are recorded as R7 and every reversal is still rejected. Drop-offs are
counted in the hour they happen, so 2,250 January trips add their drop-off to
1 February.

Known data notes: 25–26 January and 22–23 February have very low volume
because of two blizzards (real events, not missing data), and about 9% of Flex
Fare trips have no distance recorded.

## Working on the project

- `main` always runs. Work on a branch named after the feature
  (`feature/saved-views`) and merge through a pull request that one other member
  reviews.
- Commit messages say what changed in plain words, e.g. "Add W9 warning for
  missing drop-off times".
- Schema changes go in a **new** numbered file in `sql/` (e.g. `009_...sql`),
  never as edits to a file other people have already run.
- Secrets stay in `.env`. Never commit `.env` or anything in `data/`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `docker: command not found` or "cannot connect to the Docker daemon" | Open Docker Desktop and wait for **Engine running** |
| `pip install` fails building polars or psycopg | You're on the wrong Python. Use `py -3.12` (Windows) and recreate `.venv` |
| `R5: this file was already imported` | Nothing to do: that month is already in. Use `docker compose down -v` to start over |
| Port 5432 or 27017 already in use | Another PostgreSQL/MongoDB is running. Stop it, or change `POSTGRES_PORT` / `MONGO_PORT` in `.env` |
| Checksum mismatch on download | Delete the file in `data/trips/` and download again; if it still differs, TLC changed the file, so tell the team |

## Notes on MongoDB

- MongoDB 8.0 doesn't allow `$jsonSchema` validators on time-series
  collections. `origin_destination_snapshots` and `saved_analysis_views` have
  real validators. For `zone_activity_timeseries`, the loader checks every
  document against the same schema after each load and removes the month if any
  fail.
- Time-series collections only accept updates that filter on the `meta` field.
  Deletes accept any filter, which is what the monthly rebuild uses.
