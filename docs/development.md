# Working on the code

How to change Yellow Cab Query: dev mode, where each feature lives, changing
the schema or the data, and running parts of the loader by hand. To install
and run the app, see the [README](../README.md).

## Normal mode and dev mode

- **Normal mode** (`docker-compose.yml`) is the finished app. Each image holds
  a copy of the code taken at build time, and the website is compiled and
  type-checked. This is what gets demoed and marked. After changing code you
  must rebuild (`--build`) to see it.
- **Dev mode** (`docker-compose.dev.yml`, added on top) is for writing code.
  The `api` and `web` containers read your `api/` and `web/` folders directly:
  save a file and the website updates itself, and the API restarts in a second
  or two. No rebuilds. The first start takes a minute longer while it installs
  the website's packages.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

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

## What to do after a change

| You changed | Dev mode | Normal mode |
|---|---|---|
| `web/src/` (pages, components) | Nothing, it updates on save | `docker compose up -d --build web` |
| `api/` (routes, planner) | Nothing, it restarts on save; refresh the page | `docker compose up -d --build api` |
| `web/package.json` (new npm package) | `docker compose restart web` | `docker compose up -d --build web` |
| `requirements.txt` (new Python package) | Add `--build api loader` to your start command | `docker compose up -d --build api loader` |
| A new `sql/` file, or `etl/`, `scripts/` | See [Working with the database](#working-with-the-database) | same |
| `.env` or `docker-compose*.yml` | Run your start command again | `docker compose up -d` |
| Documentation | Nothing | Nothing |

After a `git pull`, run `docker compose up -d --build` if you're unsure what
changed.

## Where each feature lives

The website follows a fleet manager's path: **look** at demand, **understand**
why some zones run short, then **decide** where to station taxis.

| Feature | Backend (FastAPI) | Website (React) | Address |
|---|---|---|---|
| Analytical Dashboard | `api/routers/dashboard.py`, pipelines in `api/dashboard.py` | `web/src/pages/Dashboard.tsx`, `web/src/pages/dashboard/` | `/dashboard/overview`, `/dashboard/trends` |
| Flow Explorer | `api/routers/flows.py`, `api/flows.py` | `web/src/pages/flows/`, opened by clicking a zone in Zone maps | — |
| Saved views | `api/routers/saved_views.py`, `api/saved_views.py`, `api/filters.py` | the **Views** menu beside the dashboard filters | — |
| Allocation Planner | `api/routers/plans.py`, logic in `api/planner.py` | `web/src/pages/Planner.tsx`, `web/src/pages/planner/` | `/planner/build`, `/planner/saved` |
| Users and login | `api/auth.py`, `api/users.py`, `api/mailer.py`, `api/passwords.py`, `api/routers/auth.py`, `api/routers/users.py` | `web/src/pages/Login.tsx`, `web/src/pages/Setup.tsx`, `web/src/pages/admin/Users.tsx` | `/`, `/setup`, `/admin/users` |
| Administration and Database evaluation | `api/routers/admin.py` | `web/src/pages/Admin.tsx`, `web/src/pages/admin/` | `/admin/health`, `/evaluation/pipeline`, `/evaluation/performance` |

**Backend.** Add routes to your router file. A route `@router.get("/busiest")`
in `flows.py` is served at http://localhost:8000/flows/busiest. Get
PostgreSQL with `conn=Depends(get_pg)`, MongoDB with `mongo()` (both from
`api/db.py`), and the logged-in user with `user: User = Depends(current_user)`.
Every route shows up at http://localhost:8000/docs where you can try it. A
brand-new router file has to be added in `api/main.py` to one of `PUBLIC` (no
login), `ANY_ROLE` (fleet managers and admins) or `ADMIN_ONLY`;
`tests/test_auth.py` calls every route to check it is protected as its list
says.

**Website.** Call the backend through `web/src/api.ts` and leave off the `/api`
prefix: `api<MyType>("/flows/busiest")` or `post("/plans", body)`. The
shared map is `web/src/components/ZoneMap.tsx`; pass
`values={{ [location_id]: number }}` to colour zones (add `diverging` when
values can be negative: positive zones are drawn red, negative blue). Charts
use Recharts. A brand-new page or section has to be added to `NAV` and to the
routes in `web/src/App.tsx` to appear in the sidebar.

## Working with the database

### See what's loaded

- **Website:** the top bar lists the loaded months, and Administration → Data
  health shows rows read, warned and rejected per month, and whether both
  databases agree.
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

Add a **new** numbered file in `sql/` (the next is `020_...sql`). Never edit
one that is already in `main`. Every file is applied again on each loader run,
so write it to be safe to re-run (`CREATE TABLE IF NOT EXISTS`,
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
`scripts/download_data.py` and its counts to [data.md](data.md).

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

`reconcile.py` must print **PASSED**, and the counts must match
[data.md](data.md#results-january-to-march-2026).

- Downloads (trip files and both zone files) are checked by SHA-256. A file
  that differs is renamed to `.mismatch` so it can't be imported.
- `reconcile.py` recomputes every number in every MongoDB document (counts,
  sums, averages, destination shares) from PostgreSQL, so a hand edit to any
  of them makes it fail.
- An import is one transaction. The same file, or a second file for a month
  that's already loaded, is refused (R5), so re-running is harmless.
- `build_aggregates.py` and `load_mongo.py` delete the month before inserting,
  so re-running gives the same result.

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
right for this setup. `pytest` from the repo root runs the tests. One
`requirements.txt` covers the API, the ETL and the tests; the `api` and
`loader` images both install it.

If `pip install` fails on Polars or psycopg, recreate `.venv` with `py -3.12`.

## Team workflow

- `main` always runs. Work on a feature branch (`feature/saved-views`) and
  merge through a pull request one other member reviews.
- Before opening a pull request, run `docker compose up -d --build` (normal
  mode) and the tests.
- Schema changes go in a **new** numbered `sql/` file, never an edit to one
  already in `main`.
- Never commit `.env` or anything in `data/`.
