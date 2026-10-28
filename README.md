# Yellow Cab Query (YCQ)

A web app for taxi fleet analysts, built on the official NYC TLC yellow taxi
trip records for January to March 2026. PostgreSQL + PostGIS is the source of
truth for trips, zones, users and plans. MongoDB holds hourly zone summaries,
origin-destination snapshots and saved views. React website, FastAPI backend.
INF2003 Database Systems group project (team 24).

> YCQ uses historical completed-trip activity. Its allocation results are
> planning scenarios and do not represent live taxi availability, unmet
> passenger demand or guaranteed earnings.

## First-time setup

You only need **Docker Desktop**. On Windows, first run `wsl --install` in a
PowerShell opened **as administrator** and restart. Open Docker Desktop and
wait for **Engine running**. Keep the project **outside OneDrive or iCloud**,
because syncing the data files can lock them mid-import.

Run these in a terminal (in VS Code: **Terminal → New Terminal**):

```bash
git clone https://github.com/bonchaemanchae/ycq.git
cd ycq
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

Open `.env`, replace every `change-me` value and save: the two database
passwords, `JWT_SECRET` (a random value of at least 32 characters; the API
refuses to start without one) and the passwords of the three default accounts.
Then:

```bash
docker compose up -d --build      # build the images and start everything
docker compose logs -f loader     # watch the data load (Ctrl+C stops watching, not loading)
```

The first start downloads and imports the data: about **5 minutes per month**.
The website only comes up once the loader prints `all loaded: ...`. For a
quicker first try, set `YCQ_MONTHS=2026-01` in `.env`. Then open:

- **http://localhost:8080**, the website. Log in as `admin@ycq.local`,
  `analyst1@ycq.local` or `analyst2@ycq.local` with the passwords you put in
  `.env`. The header should read
  *PostgreSQL up · MongoDB up · months: 2026-01, ...*
- **http://localhost:8000/docs**, the API, where you can try every route.
  Log in with `POST /auth/login`, then press **Authorize** and paste the token.

**Already set up before login existed?** Add `YCQ_ADMIN_PASSWORD`,
`YCQ_ANALYST1_PASSWORD` and `YCQ_ANALYST2_PASSWORD` to your `.env` (see
`.env.example`), make sure `JWT_SECRET` is at least 32 characters, and run
`docker compose up -d --build`.

All `docker compose` commands must be run from the folder that contains
`docker-compose.yml`.

## What runs

`docker compose up` starts five containers:

| Service | What it is | Where |
|---|---|---|
| `postgres` | PostgreSQL 16 + PostGIS | `localhost:5432` |
| `mongo` | MongoDB 8.0 | `localhost:27017` |
| `loader` | Downloads the TLC files into `data/`, applies `sql/`, loads zones, imports each month, builds summaries, fills MongoDB, runs reconciliation, then **exits**. Months already loaded are skipped, so later starts take seconds | `docker compose logs loader` |
| `api` | FastAPI backend. Logs in to MongoDB as `MONGO_APP_USER`, which the loader creates with read/write on the `ycq` database only (not root) | http://localhost:8000/docs |
| `web` | React website; `/api/*` is forwarded to `api` | http://localhost:8080 |

The data is kept in Docker volumes (`pgdata`, `mongodata`), so it survives
`docker compose down` and restarts. Only `docker compose down -v` deletes it.

## Everyday commands

| To | Run |
|---|---|
| Start (normal mode) | `docker compose up -d` |
| Start in dev mode (while coding) | `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` |
| Stop (data is kept) | `docker compose down` |
| Rebuild after code changes (normal mode) | `docker compose up -d --build` |
| See what's running | `docker compose ps -a` |
| See a container's output or errors | `docker compose logs api` (or `web`, `loader`, `postgres`, `mongo`) |
| Restart one container | `docker compose restart api` |
| Run the tests | `docker compose run --rm loader pytest tests` |
| Delete all data and start over | `docker compose down -v`, then `docker compose up -d --build` |

### Normal mode and dev mode

- **Normal mode** (`docker-compose.yml`) is the finished app. Each image holds
  a copy of the code taken at build time, and the website is compiled and
  type-checked. This is what gets demoed and marked. After changing code you
  must rebuild (`--build`) to see it.
- **Dev mode** (`docker-compose.dev.yml`, added on top) is for writing code.
  The `api` and `web` containers read your `api/` and `web/` folders directly:
  save a file and the website updates itself, and the API restarts in a second
  or two. No rebuilds. The first start takes a minute longer while it installs
  the website's packages.

Work in dev mode. Before you push, switch to normal mode once with
`docker compose up -d --build` and click through your page, because dev mode
skips the TypeScript check that the real build runs. You can switch between
the modes any time; the data stays.

To avoid typing the long dev command, add this line to your `.env` and every
plain `docker compose` command uses dev mode (comment it out with `#` to go
back). On macOS or Linux use `:` instead of `;`.

```
COMPOSE_FILE=docker-compose.yml;docker-compose.dev.yml
```

### What to do after a change

| You changed | Dev mode | Normal mode |
|---|---|---|
| `web/src/` (pages, components) | Nothing, it updates on save | `docker compose up -d --build web` |
| `api/` (routes, planner) | Nothing, it restarts on save; refresh the page | `docker compose up -d --build api` |
| `web/package.json` (new npm package) | `docker compose restart web` | `docker compose up -d --build web` |
| `requirements.txt` (new Python package) | Add `--build api loader` to your start command | `docker compose up -d --build api loader` |
| A new `sql/` file, or `etl/`, `scripts/` | See [Working with the database](#working-with-the-database) | same |
| `.env` or `docker-compose*.yml` | Run your start command again | `docker compose up -d` |
| `README.md` | Nothing | Nothing |

After a `git pull`, run `docker compose up -d --build` if you're unsure what
changed.

## Adding your part

Each feature from the report has one backend file and one page:

| Feature (owner) | Backend (FastAPI) | Website (React) | URL |
|---|---|---|---|
| Activity Dashboard (Kessler) | `api/routers/dashboard.py`, pipelines in `api/dashboard.py` | `web/src/pages/Dashboard.tsx` | `/dashboard` |
| Flow Explorer (Caleb) | `api/routers/flows.py` | `web/src/pages/Flows.tsx` | `/flows` |
| Allocation Planner (Anna) | `api/routers/plans.py`, logic in `api/planner.py` | `web/src/pages/Planner.tsx` | `/planner` |
| Saved Views (Caleb) | `api/routers/saved_views.py` | save and open buttons on the Dashboard and Flow pages | — |
| Users and Security (Arif) | `api/auth.py`, `api/users.py`, `api/routers/auth.py`, `api/routers/users.py` | `web/src/pages/Login.tsx`, Users on the Administration page | — |
| Administration (Sean) | `api/routers/admin.py` | `web/src/pages/Admin.tsx` | `/admin` |

**Backend.** Add routes to your router file. A route `@router.get("/busiest")`
in `flows.py` is served at http://localhost:8000/flows/busiest. Get
PostgreSQL with `conn=Depends(get_pg)`, MongoDB with `mongo()` (both from
`api/db.py`), and the logged-in user with `user: User = Depends(current_user)`.
Every route shows up at http://localhost:8000/docs where you can try it. A
brand-new router file has to be added in `api/main.py` to one of `PUBLIC` (no
login), `ANY_ROLE` (analysts and admins) or `ADMIN_ONLY`; `tests/test_auth.py`
calls every route to check it is protected as its list says.

**Website.** Call the backend through `web/src/api.ts` and leave off the `/api`
prefix: `api<MyType>("/flows/busiest")` or `post("/plans", body)`. The
shared map is `web/src/components/ZoneMap.tsx`; pass
`values={{ [location_id]: number }}` to colour zones (add `diverging` when
values can be negative). Charts use Recharts. A brand-new page has to
be added to `PAGES` in `web/src/App.tsx` to get a tab.

### Activity Dashboard

The landing page. Every part of it follows the same filters: a date range,
days of the week, a range of hours (22 to 2 wraps past midnight), boroughs,
and whether the map shows pickups, drop-offs or the imbalance between them.
It reads MongoDB through these routes (each takes the filters as query
parameters, named like a saved view's filters):

| Route | What it returns | MongoDB features |
|---|---|---|
| `GET /dashboard` | Totals and every zone with its rank, share and imbalance (map, tables) | `$facet`, `$setWindowFields` (`$rank`, window `$sum`) |
| `GET /dashboard/series` | Pickups and drop-offs per day or hour, with a 7-day or 24-hour moving average | `$setWindowFields` (window `$avg`) |
| `GET /dashboard/weekdays` | Average pickups per day for each weekday, and for each weekday and hour | `$facet`, two-stage `$group` |
| `GET /dashboard/compare` | Up to three zones side by side: median and 90th percentile of hourly pickups, peak hour | `$median`, `$percentile` |
| `GET /dashboard/context` | Loaded date range, latest import and your recent plans (PostgreSQL) | — |

Averages are total sums divided by total counts, so they match PostgreSQL for
the same rows (`tests/test_dashboard.py` checks every route against
`zone_hour_observation`).

Each question reads the smallest of three collections that holds what it
needs (`source()` in `api/dashboard.py`). All three are built from
`zone_hour_observation` with the same field names, so the pipelines are the
same on each:

| Collection | One document per | Documents (3 months) | Used for |
|---|---|---|---|
| `zone_activity_timeseries` | zone and hour (time series) | 567,817 | the summary when hours are filtered, any question about chosen zones, comparing zones |
| `zone_activity_daily` | zone and day | 23,670 | the summary (map, totals, zone table) |
| `borough_activity_hourly` | borough and hour | 12,954 | activity over time, weekdays |

Over three months this takes each question from about 2 seconds to under 50
ms, with the same answer. Every response says which collection answered
(`source`) and how long it took (`queryMs`), and the page shows it under each
chart. The loader builds the two pre-summed collections with the others, and
reconciliation checks every field of every document against PostgreSQL.

### Saved views

The Activity Dashboard and Flow Explorer each have a **Saved views** panel:
name the page as it is and save it, open it again later, save changes into
it, rename it or delete it. Views are each user's own and live in MongoDB
(`saved_analysis_views`), so this is the app's CRUD on the NoSQL side, as
plans are on the PostgreSQL side.

| Route | What it does |
|---|---|
| `GET /views?page=dashboard` | Your views, newest first (optionally one page's) |
| `POST /views` | Save `{name, page, filters, widgets}` |
| `GET /views/{id}` | One view |
| `PATCH /views/{id}` | Rename, or store the page's new filters or widgets |
| `DELETE /views/{id}` | Delete it |

`filters` are the page's own, defined once in `api/filters.py`: the
dashboard's date range, weekdays, hours, boroughs and metric, or the Flow
Explorer's origin zone, month, day type and time of day. A view holds only
its page's filters, so it always reopens as saved, and MongoDB's
`$jsonSchema` validator is generated from the same definition. `widgets` is
free-form: the dashboard keeps its compared zones and hourly or daily chart
there, the Flow Explorer whether the month comparison is open. A zone or
borough is checked against PostgreSQL before a view is saved, since MongoDB
can't hold a foreign key into it.

### Rules the database enforces on saved plans

Saved allocation plans are checked by the database itself, not only by the API
(`sql/006`, `011`, `012`):

- every hour of a version adds up exactly to the fleet size, and no hour in the
  version's range is missing;
- every result's zone has a map shape and is in one of the version's boroughs;
- a saved version, its boroughs and its results can't be updated or deleted on
  their own. Changes are saved as a new version, and deleting the plan removes
  all its versions.

### Users and login

- **Accounts:** the three default accounts are created by the loader from `.env`
  (`scripts/seed_users.py`); an account whose password variable is empty isn't
  created. Changing a password in `.env` updates it on the next
  `docker compose up -d`. Admins add any other accounts under
  Administration → Users; there is no self sign-up.
- **Passwords** are stored as Argon2id hashes. Logging in returns a token valid
  for 8 hours; the website keeps it until the tab is closed. The token only
  says who you are: your roles and whether your account still exists are
  checked on every request, so changes apply immediately.
- **Roles:** analysts use every page except Administration; admins use all of
  them.
- **Deleting a user** (Administration → Users) also deletes their saved plans
  (PostgreSQL) and saved views (MongoDB). The order, and why a failure part way
  can simply be retried, is explained at the top of `api/users.py`. A deleted
  default account comes back, empty, on the next start while its password is
  still in `.env`.

## Working with the database

### See what's loaded

- **Website:** the header lists the loaded months, and the Administration page
  shows rows read, accepted and rejected per month.
- **Loader output:** `docker compose logs loader` shows each month's counts and
  whether reconciliation **PASSED**.
- **PostgreSQL shell**, no password needed:

  ```bash
  docker compose exec postgres psql -U ycq -d ycq
  ```

  Useful queries: `\dt` (tables), `\d trip` (one table's columns),
  `SELECT file_month, rows_read, rows_accepted, rows_rejected FROM import_batch;`,
  `SELECT reason_code, count(*) FROM rejected_trip GROUP BY 1;`. Quit with `\q`.

- **MongoDB shell:**

  ```bash
  docker compose exec mongo sh -c 'mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin ycq'
  ```

  Useful commands: `show collections`,
  `db.zone_activity_timeseries.findOne()`,
  `db.origin_destination_snapshots.countDocuments()`. Quit with `exit`.

- **With a GUI:** DBeaver or pgAdmin at `localhost:5432` (database `ycq`), and
  MongoDB Compass with
  `mongodb://ycq:<MONGO_PASSWORD>@localhost:27017/?authSource=admin`. The users
  and passwords are the ones in your `.env`.

### Change the schema

Add a **new** numbered file in `sql/` (for example `014_my_table.sql`). Never
edit one that is already in `main`. Every file is applied again on each
loader run, so write it to be safe to re-run (`CREATE TABLE IF NOT EXISTS`,
`CREATE OR REPLACE VIEW`, and so on). Then apply it:

```bash
docker compose up -d --build loader
```

Your loaded data stays. Check the loader log for errors.

### Change the MongoDB validators or indexes

Edit `ensure_collections` in `etl/load_mongo.py`, then run
`docker compose up -d --build loader`. The loader re-applies them on every
run.

### Add another month

Add it to `YCQ_MONTHS` in `.env` (for example
`YCQ_MONTHS=2026-01 2026-02 2026-03 2026-04`) and run `docker compose up -d`.
The loader downloads and imports only the new month and refreshes the
planner's median fares. Then add its checksum to `KNOWN_SHA256` in
`scripts/download_data.py` and its counts to the results table below.

### Change the import rules or summaries

A month can only be imported once (rule R5). To import it again after a change
to `etl/import_month.py`, or because TLC republished it, remove just that month
first. Users, plans and saved views are kept:

```bash
docker compose build loader
docker compose run --rm loader python etl/delete_month.py --month 2026-01
docker compose up -d                  # the loader imports the month again
```

`delete_month.py` removes, in one transaction, the month's trips (its
partition), warnings, rejected rows, hourly summaries and import batch, then
refreshes the views and deletes the month's MongoDB documents. If the next month
is loaded too, rebuild its summaries afterwards (below), because drop-offs late
on the deleted month's last day are counted there. Run the tests after any rule
change.

`docker compose down -v` also starts over, but it deletes **everything**,
including users, plans and saved views that can't be rebuilt.

A change to `build_aggregates.py` or `load_mongo.py` doesn't need a re-import.
Those scripts delete a month before rebuilding it, so you can rerun them per
month:

```bash
docker compose build loader
docker compose run --rm loader python etl/build_aggregates.py --month 2026-01
docker compose run --rm loader python etl/load_mongo.py --month 2026-01
docker compose run --rm loader python etl/reconcile.py --month 2026-01
```

`docker compose run --rm loader python <script>` runs any ETL script without
installing Python yourself.

### Load the data step by step

This is what the loader does, one step at a time. Use it to run a single step
(prefix each line with `docker compose run --rm loader`, or run it in a local
`.venv`; see [Without Docker](#without-docker)):

```bash
python scripts/download_data.py --months 2026-01 2026-02 2026-03
python etl/setup_db.py
python etl/load_zones.py
# then for each month, in order:
python etl/import_month.py     --month 2026-01
python etl/build_aggregates.py --month 2026-01
python etl/load_mongo.py       --month 2026-01
python etl/reconcile.py        --month 2026-01
```

`reconcile.py` must print **PASSED**, and the counts must match the
[results table](#results-january-to-march-2026).

- Downloads (trip files and both zone files) are checked by SHA-256. A file
  that differs is renamed to `.mismatch` so it can't be imported.
- `reconcile.py` recomputes every number in every MongoDB document (counts,
  sums, averages, destination shares) from PostgreSQL, so a hand edit to any
  of them makes it fail.
- An import is one transaction. The same file, or a second file for a month
  that's already loaded, is refused (R5), so re-running is harmless.
- `build_aggregates.py` and `load_mongo.py` delete the month before inserting,
  so re-running gives the same result.

### Run the benchmark

Compares PostgreSQL and MongoDB on the app's own questions. Run it after all
months are loaded; it takes a few minutes and the results appear on the
Administration page.

```bash
docker compose build loader                                   # picks up the script
docker compose run --rm loader python etl/benchmark.py        # 50 timed runs per query
docker compose run --rm loader python etl/benchmark.py --explain-summary 2026-01
```

It copies the summaries into three benchmark stores (`bench_zone_hour` in
PostgreSQL, `bench_zone_hour_collection` and `bench_zone_hour_timeseries` in
MongoDB) with equivalent indexes, then runs four queries against each: one zone
for one hour, one zone over seven days, totals for every zone over a month,
and the top 10 zones for a month. A fifth query tests the Flow Explorer, the
case MongoDB was chosen for: the top 10 destinations for one origin zone,
filtered and sorted from `od_summary` in PostgreSQL against one embedded
document in `origin_destination_snapshots`. It records a cold run, the median
and 95th percentile of the timed runs, data and index size, load time and each
query plan, and saves them to `benchmark_run` only if every store gave the same
answers. Questions 6 and 7 are the Activity Dashboard's heaviest over all three
months (every zone's totals, and pickups by weekday and hour), on the app's
real stores: `zone_hour_observation`, the hourly time series, and the
pre-summed collection the dashboard reads. `--explain-summary` prints
`EXPLAIN ANALYZE` of one month's summary build and changes nothing.

## Tests

```bash
docker compose build loader          # picks up changed tests
docker compose run --rm loader pytest tests
```

The tests build separate `ycq_test` databases in the same containers, so your
real data is never touched. They import small hand-made files with the real
scripts, then check every import rule, the hourly grid (including the
daylight-saving hour), rebuilds, the median fare table, the plan rules, and
MongoDB's validators and reconciliation. A run takes under a minute.

## Without Docker

Only needed if you want to run the Python or the website on your own machine.
You need **Python 3.12** and **Node.js 22**. The databases still run in Docker.

```bash
py -3.12 -m venv .venv        # Windows; macOS: python3 -m venv .venv
.venv\Scripts\activate        # Windows; macOS: source .venv/bin/activate
pip install -r requirements.txt
docker compose stop api web                 # frees ports 8000 and 8080
uvicorn api.main:app --reload               # terminal 1, repo root
cd web && npm install && npm run dev        # terminal 2: http://localhost:5173
```

On Windows use the `py` launcher: other Pythons on the PATH (such as MSYS2)
can't install Polars or psycopg. `.env` already points at `localhost`, which is
right for this setup. `pytest` from the repo root runs the tests.

## Repository layout

```
api/        FastAPI backend: main.py, db.py, auth.py, planner.py, routers/ (one per feature)
web/        React + TypeScript (Vite) website: src/pages/ (one per feature), src/components/
sql/        schema, applied in number order by etl/setup_db.py
etl/        load_all (what the loader container runs), setup_db, load_zones,
            import_month, build_aggregates, load_mongo, reconcile, delete_month,
            benchmark
scripts/    download_data.py (TLC files + checksum check)
tests/      pytest suite (uses its own ycq_test databases)
data/       downloaded files (not in git)
docker-compose.yml       normal mode
docker-compose.dev.yml   dev mode, added on top of the normal file
```

One `requirements.txt` covers the API, the ETL and the tests; the `api` and
`loader` images both install it.

## Import rules

Every row is either **accepted** into `trip` or **rejected** into
`rejected_trip` with one reason code (the first rule that applies, checked in
the order R1, R2, R3, R6, R4, R8, R9, R7):

| Code | Rejected when |
|---|---|
| R1 | Pickup or drop-off time missing |
| R2 | Drop-off before pickup |
| R3 | Pickup outside the file's month |
| R6 | Trip longer than 24 hours |
| R4 | Pickup zone missing or has no map shape (zones 264, 265) |
| R8 | Vendor, payment type or rate code not in its lookup table (rate code 99 and a missing rate code are still accepted). None in the three 2026 files; without it, one such row would abort the whole month |
| R9 | Impossible value: negative passenger count, or a passenger count, distance or money amount too large for its column, or not a number (NaN, infinity). None in the three 2026 files; same reason as R8 |
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

After all three months, `zone_weekday_hour_fare` (the planner's median fares)
has 34,521 rows built from 7,911,745 metered trips. No month has voided trips
(W7). In January, 35,171 negative-fare rows have a positive twin; 123 of them
already fail an earlier rule (121 R4, 1 R3, 1 R6), so 35,048 are recorded as R7
and every reversal is still rejected. Drop-offs are counted in the hour they
happen, so 2,250 January trips add their drop-off to 1 February.

Known data notes: 25–26 January and 22–23 February have very low volume
because of two blizzards (real events, not missing data), and about 9% of Flex
Fare trips have no distance recorded.

## Working on the project

- `main` always runs. Work on a feature branch (`feature/saved-views`) and
  merge through a pull request one other member reviews.
- Before opening a pull request, run `docker compose up -d --build` (normal
  mode) and the tests.
- Schema changes go in a **new** numbered `sql/` file, never an edit to one
  already in `main`.
- Never commit `.env` or anything in `data/`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "cannot connect to the Docker daemon" | Open Docker Desktop and wait for **Engine running** |
| "no configuration file provided" | You're in the wrong folder. `cd` into the one with `docker-compose.yml` |
| http://localhost:8080 doesn't open | `loader` is still running or failed: `docker compose logs loader` |
| Website shows "Bad Gateway" or "backend not reachable" | The `api` container crashed: `docker compose logs api` shows why. Fix it, then `docker compose up -d --build api` |
| My change doesn't show | Normal mode needs `--build`. In dev mode try `docker compose restart api` (or `web`) |
| Port 8000 or 8080 in use | Change `API_PORT` / `WEB_PORT` in `.env` |
| Port 5432 or 27017 in use | Stop the other database, or change `POSTGRES_PORT` / `MONGO_PORT` in `.env` |
| `R5: ... already imported` | That month is already in. To import it again, `etl/delete_month.py` it first; see [Change the import rules](#change-the-import-rules-or-summaries) |
| Checksum mismatch | Download again. If it still differs, TLC changed the file: tell the team and don't import it |
| `pip install` fails on polars or psycopg | Wrong Python. Recreate `.venv` with `py -3.12` |

MongoDB 8.0 doesn't allow `$jsonSchema` validators on time-series collections,
so the loader checks every hourly document itself and removes the month if any
fail. Saved views only live in MongoDB, so back them up with `mongodump`.
