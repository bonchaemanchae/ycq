# Yellow Cab Query (YCQ)

A web app for taxi fleet analysts, built on the official NYC TLC yellow taxi
trip records for January to March 2026. PostgreSQL + PostGIS is the source of
truth for trips, zones, users and plans. MongoDB holds hourly zone summaries,
origin-destination snapshots and saved views. INF2003 Database Systems group
project.

> YCQ uses historical completed-trip activity. Its allocation results are
> planning scenarios and do not represent live taxi availability, unmet
> passenger demand or guaranteed earnings.

## Setup

You need **Docker Desktop** (on Windows, run `wsl --install` in an admin
PowerShell first and restart) and **Python 3.12+**. Open Docker Desktop and
wait for **Engine running**.

```bash
git clone https://github.com/bonchaemanchae/ycq.git
cd ycq
cp .env.example .env          # set your own passwords in .env
docker compose up -d          # PostgreSQL + PostGIS and MongoDB
```

Python environment:

```bash
py -3.12 -m venv .venv        # Windows; macOS: python3 -m venv .venv
.venv\Scripts\activate        # Windows; macOS: source .venv/bin/activate
pip install -r requirements.txt
```

On Windows use the `py` launcher: other Pythons on the PATH (such as MSYS2)
can't install Polars or psycopg. Keep the folder **outside OneDrive or
iCloud**, because syncing the data files can lock them mid-import.

## Loading the data

```bash
python scripts/download_data.py --months 2026-01 2026-02 2026-03
python etl/setup_db.py
python etl/load_zones.py
```

Then for each month, in order (`2026-01`, `2026-02`, `2026-03`):

```bash
python etl/import_month.py     --month 2026-01
python etl/build_aggregates.py --month 2026-01
python etl/load_mongo.py       --month 2026-01
python etl/reconcile.py        --month 2026-01
```

Each month takes about 5 minutes. `reconcile.py` must print **PASSED**, and
your counts must match the [results table](#results-january-to-march-2026).

- Downloads are checked by SHA-256. A file that differs is renamed to
  `.mismatch` so it can't be imported.
- An import is one transaction. The same file, or a second file for a month
  that's already loaded, is refused (R5), so re-running is harmless.
- `build_aggregates.py` and `load_mongo.py` delete the month before inserting,
  so re-running gives the same result.
- Start completely fresh with `docker compose down -v`, then load again.

## Tests

With the containers running, run `pytest` from the repo root. The tests build
separate `ycq_test` databases in the same containers, so your real data is
never touched. They import small hand-made files with the real scripts, then
check every import rule, the hourly grid (including the daylight-saving hour),
rebuilds, the median fare table, the plan rules, and MongoDB's validators and
reconciliation. A run takes under a minute.

## Repository layout

```
sql/        schema, applied in number order by etl/setup_db.py
etl/        setup_db, load_zones, import_month, build_aggregates, load_mongo, reconcile
scripts/    download_data.py (TLC files + checksum check)
tests/      pytest suite (uses its own ycq_test databases)
data/       downloaded files (not in git)
```

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
| R5 | File refused: the same file, or another file for the same month, was already imported (the import stops and writes nothing) |

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

After all three months, `zone_weekday_hour_fare` (the planner's median fares) has 34,521 rows built from 7,911,745 metered trips. No month has voided trips (W7). In January, 35,171 negative-fare rows have a
positive twin; 123 of them already fail an earlier rule (121 R4, 1 R3, 1 R6),
so 35,048 are recorded as R7 and every reversal is still rejected. Drop-offs are
counted in the hour they happen, so 2,250 January trips add their drop-off to
1 February.

Known data notes: 25–26 January and 22–23 February have very low volume
because of two blizzards (real events, not missing data), and about 9% of Flex
Fare trips have no distance recorded.

## Working on the project

- `main` always runs. Work on a feature branch (`feature/saved-views`) and
  merge through a pull request one other member reviews.
- Schema changes go in a **new** numbered `sql/` file, never an edit to one
  already in `main`.
- Never commit `.env` or anything in `data/`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "cannot connect to the Docker daemon" | Open Docker Desktop and wait for **Engine running** |
| `pip install` fails on polars or psycopg | Wrong Python. Recreate `.venv` with `py -3.12` |
| `R5: ... already imported` | That month is already in. `docker compose down -v` to start over |
| Port 5432 or 27017 in use | Stop the other database, or change `POSTGRES_PORT` / `MONGO_PORT` in `.env` |
| Checksum mismatch | Download again. If it still differs, TLC changed the file: tell the team and don't import it |

MongoDB 8.0 doesn't allow `$jsonSchema` validators on time-series collections,
so the loader checks every hourly document itself and removes the month if any
fail. Saved views only live in MongoDB, so back them up with `mongodump`.
