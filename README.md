# Yellow Cab Query

Yellow Cab Query helps New York yellow-cab fleet managers decide where to
station their taxis. It turns the official NYC TLC trip records for January to
March 2026 (11.1 million trips) into demand maps, shortage analysis and
shift-by-shift allocation plans. It uses two databases: PostgreSQL with PostGIS
is the source of truth, and MongoDB holds summaries shaped for the pages that
read them.

INF2003 Database Systems group project, team 24.

> Plans are built from past completed trips. They are planning scenarios, not
> live taxi positions, unmet passenger demand or guaranteed earnings.

## Features

**Analytical Dashboard** (served by MongoDB)

- **Zone maps:** filter by dates, days of the week, hours and boroughs; totals
  for pickups, taxi balance, fare and trip length; a demand map and a shortages
  map (zones where pickups outnumber drop-offs); every zone ranked; compare up
  to three zones side by side
- **Flow Explorer:** click a zone to see the top 10 places its trips go, by
  month, weekday or weekend, and time band
- **Daily trends:** pickups per day or hour with a moving average, and the
  unusual days, at least 30% above or below a normal day of the same weekday
- **Saved views:** save, open, rename and delete a dashboard view

**Allocation Planner** (served by PostgreSQL)

- **Build a plan:** choose a day, hours, fleet size and boroughs; the planner
  ranks the zones for each hour and splits the fleet between them
- **Edit and save:** change any number; a plan saves only when every hour adds
  up to the fleet, and every save is a new version
- **Saved plans:** each version is sealed by a hash chain; compare two
  versions, rename or delete a plan

**Administration** (admins only)

- **User management:** invite people by email as Fleet manager or Admin; they
  set their own password from a one-time link; disable accounts
- **Data health:** whether every month loaded, whether both databases agree,
  whether every saved view has an owner, and whether any saved plan was altered

**Database evaluation** (admins only)

- **Data pipeline:** how each row is checked, stored in PostgreSQL and
  summarised into MongoDB, with the rejected rows and the rule that caught each
- **Performance:** speed, size and throughput of both databases on the app's
  own queries

Admins also see on every page which collection answered each chart and how
long it took, the planner's scoring details and its PostgreSQL vs MongoDB
check. Fleet managers see only the answers.

## How it works

```
TLC trip files ──> loader ──> PostgreSQL ──> MongoDB
                  (checks,     (trips, zones,  (summaries for each
                   imports,     users, plans)   page, saved views)
                   summarises)       │              │
                                     └──── api ─────┘ ──> website
```

PostgreSQL keeps every trip, zone, user and saved plan, and enforces the rules
itself: constraints, triggers and row-level security. MongoDB holds summaries
built from PostgreSQL for the pages that are read most, plus the saved views.
After every load the two are compared number by number.

`docker compose up` starts six containers:

| Container | What it is | Address |
|---|---|---|
| `postgres` | PostgreSQL 16 with PostGIS 3.4 | `localhost:5432` |
| `mongo` | MongoDB 8.0 | `localhost:27017` |
| `loader` | Downloads the TLC files, builds the schema, imports each month, builds the summaries, fills MongoDB, checks both databases agree, then exits | `docker compose logs loader` |
| `api` | FastAPI backend, connecting with its own restricted database logins | http://localhost:8000/docs |
| `web` | React website | http://localhost:8080 |
| `mailpit` | Test mail server that catches the invitation emails | http://localhost:8025 |

**Built with:** Python 3.12, Polars, psycopg 3, PyMongo, FastAPI, Argon2id
password hashing; React 18, TypeScript, Vite, Leaflet, Recharts; Docker
Compose.

More detail: [docs/database.md](docs/database.md).

## Quick start

**You need** Docker Desktop. On Windows, first run `wsl --install` in a
PowerShell opened as administrator, then restart. Open Docker Desktop and wait
for **Engine running**. Keep the project outside OneDrive or iCloud, because
syncing can lock the data files during an import.

1. Get the code and create your settings file:

   ```bash
   git clone https://github.com/bonchaemanchae/ycq.git
   cd ycq
   cp .env.example .env          # PowerShell: Copy-Item .env.example .env
   ```

2. Open `.env` and replace every `change-me` value (see
   [Configuration](#configuration)).

3. Build and start everything, then watch the data load:

   ```bash
   docker compose up -d --build
   docker compose logs -f loader     # Ctrl+C stops watching, not loading
   ```

   The first start downloads and imports the data, about 5 minutes per month.
   The website comes up once the loader prints `all loaded: ...`. Later starts
   take seconds, because loaded months are skipped.

4. Open http://localhost:8080 and log in with one of the default accounts,
   using the passwords you set in `.env`:

   | Email | Name | Role |
   |---|---|---|
   | `admin@ycq.local` | Admin | Admin |
   | `analyst1@ycq.local` | Maya Chen | Fleet manager |
   | `analyst2@ycq.local` | Daniel Rivera | Fleet manager |

The API's own documentation, where every route can be tried, is at
http://localhost:8000/docs (log in with `POST /auth/login`, then press
**Authorize** and paste the token). Invitation emails arrive in the test inbox
at http://localhost:8025; nothing reaches a real inbox.

Run every `docker compose` command from the folder that holds
`docker-compose.yml`.

### Stopping and if something goes wrong

| To | Run |
|---|---|
| Stop the app (data is kept) | `docker compose down` |
| Start it again | `docker compose up -d` |
| Delete all data and start over | `docker compose down -v`, then `docker compose up -d --build` |

`down -v` also deletes users, saved plans and saved views.

| Problem | Fix |
|---|---|
| "cannot connect to the Docker daemon" | Open Docker Desktop and wait for **Engine running** |
| "no configuration file provided" | You're in the wrong folder: `cd` into the one with `docker-compose.yml` |
| http://localhost:8080 doesn't open | The data is still loading, or the load failed: `docker compose logs loader` |
| A port is already in use | Change `WEB_PORT`, `API_PORT`, `POSTGRES_PORT` or `MONGO_PORT` in `.env` |

## Configuration

All settings live in `.env`, which is never committed.

| Setting | Required | What it is |
|---|---|---|
| `POSTGRES_PASSWORD`, `MONGO_PASSWORD` | Yes | Passwords of the database owners, used by the loader and tests |
| `POSTGRES_APP_PASSWORD`, `MONGO_APP_PASSWORD` | Yes | Passwords of the API's restricted logins |
| `JWT_SECRET` | Yes | Signs login tokens; at least 32 characters, or the API won't start. Make one with `python -c "import secrets; print(secrets.token_hex(32))"` |
| `YCQ_ADMIN_PASSWORD`, `YCQ_ANALYST1_PASSWORD`, `YCQ_ANALYST2_PASSWORD` | Yes | Passwords of the three default accounts, at least 12 characters. Leave one empty to skip that account |
| `YCQ_MONTHS` | No | Months to load, default `2026-01 2026-02 2026-03`. Set `2026-01` for a quicker first try |
| `YCQ_DOWNLOAD` | No | `0` uses the files already in `data/` instead of downloading |
| `API_PORT`, `WEB_PORT` | No | Change these if 8000 or 8080 is in use |
| `SMTP_HOST`, `SMTP_PORT`, `APP_URL` | No | To send real email, point these at a mail server and at where the website runs |

Changing a password in `.env` updates the account on the next
`docker compose up -d`.

## Using the app

1. **Log in** at http://localhost:8080. There is no sign-up: an admin invites
   each person.
2. **Find where demand is.** Zone maps opens on all three months. Use
   **Filters** to narrow the dates, days, hours or boroughs; any filter that is
   on shows as a yellow chip, and the map zooms to the chosen boroughs.
3. **Find where taxis run short.** Switch the map to **Shortages**: red zones
   lose more taxis than they gain. Click a zone to open the Flow Explorer and
   see where its trips go; press **+** to compare it with others.
4. **Plan the shift.** Press **Allocate taxis**. The planner opens with your
   filters and the zones you looked at. Set the day, hours, fleet size and
   boroughs, adjust any number, then **Save plan**.
5. **Review plans** under **Saved plans**: open, compare, rename or delete.
6. **Admins:** invite or disable users under **User management**, and check
   **Data health** after loading data.

## Testing

```bash
docker compose build loader          # picks up changed tests
docker compose run --rm loader pytest tests
```

377 tests run against separate `ycq_test` databases in the same containers,
so your real data is never touched. They load small hand-made files with the
real scripts.

| Area | What the tests prove |
|---|---|
| Data loading | Every reject and warning rule catches the right rows; accepted plus rejected equals rows read; a month can't load twice; daylight saving and month-end drop-offs are handled |
| Database rules on plans | The triggers refuse a plan whose hours don't add up, a zone outside its boroughs, or an edit to a saved version; the hash chain catches a change made with the triggers switched off |
| Security | Argon2id password hashing; every route has the right protection; the API's database login isn't a superuser and can't delete accounts; row-level security limits each user to their own plans; invitation links work once and expire |
| MongoDB | Validators refuse bad documents; reconciliation catches a tampered document; saved views do full create, read, update and delete for their owner only, and refuse an update from a stale copy |
| Both databases agree | Every dashboard number is checked against PostgreSQL; the planner's statistics are the same in both databases; the same inputs always give the same plan |
| Evaluation tools | The benchmark's maths and stores are right; the backtest can't see the month it is scored on; the load test and evidence scripts change nothing |

## Performance evaluation

Four tools measure the design. All of them only read data. Run them after
every month is loaded:

| Tool | What it measures | Command | Results |
|---|---|---|---|
| Speed benchmark | 7 queries the app runs, 50 times each, on the same data in PostgreSQL, a MongoDB collection, a MongoDB time-series collection and the pre-summed collections. Median and 95th percentile, storage size, load time and each query plan. Saved only if every store returns the same answers. Takes a few minutes | `docker compose run --rm loader python etl/benchmark.py` | Database evaluation → Performance |
| Load test | Requests a second, response times and failures for five features, with 1, 5, 10, 20, 50 and 80 users at once through the real API and logins. Takes about 10 minutes | `docker compose run --rm loader python etl/load_test.py` | Database evaluation → Performance, Throughput |
| Planner backtest | Plans built from January and February only, scored on March against "busiest zones" and random zones | `docker compose run --rm loader python etl/backtest_planner.py` | Printed in the terminal |
| Design evidence | Why each store is laid out as it is: bucket counts, which collection answers each dashboard question, and the query plans. Takes about a minute | `docker compose run --rm loader python etl/evidence.py` | Printed in the terminal |

Run `docker compose build loader` first if the scripts changed. The load test
logs in as `analyst1@ycq.local`, so that account needs its password in `.env`.
The API and the load test share one machine, so compare its ratios rather than
the absolute numbers.

**Headline results** (January to March 2026):

- PostgreSQL is fastest for small lookups (one zone, one hour: 0.12 ms).
- The MongoDB time-series collection is 19 times smaller than PostgreSQL and
  fastest for the top 10 zones in a month, but takes twice as long to load.
- The pre-summed collections answer the dashboard 1.8 to 3.1 times faster than
  PostgreSQL for about 4 MB of extra storage.
- Planner backtest: the zones the planner picks cover 69.3% of March's taxi
  shortage, against 61.3% for the busiest zones and 3.8% for random zones.

Options and details: [docs/database.md](docs/database.md#evaluation-tools).

## Data

- **Source:** the official [NYC TLC yellow taxi trip records](https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page)
  for January to March 2026, and TLC's 263 taxi zones with their map shapes.
- **Checked:** each download is matched against a SHA-256 checksum pinned in
  the repository; a file that differs is never imported.
- **Cleaned, not dropped:** every row is either accepted into PostgreSQL or
  kept aside with the rule that rejected it. Accepted rows with a suspicious
  value are kept, flagged, and left out of the averages it would distort.

| | January | February | March |
|---|---:|---:|---:|
| Rows read | 3,724,889 | 3,399,866 | 3,952,451 |
| Accepted | 3,683,870 | 3,371,085 | 3,927,859 |
| Rejected | 41,019 | 28,781 | 24,592 |
| Both databases agree | yes | yes | yes |

The full rules and per-rule counts: [docs/data.md](docs/data.md).

## Project structure

```
api/        FastAPI backend: one router per feature, the planner, login and users
web/        React and TypeScript website: one folder per page, shared components
sql/        PostgreSQL schema, applied in number order
etl/        loader scripts, plus benchmark, load_test, backtest_planner and evidence
scripts/    data download with checksum check, default accounts
tests/      pytest suite, using its own ycq_test databases
docs/       development guide, data rules and database design notes
data/       downloaded TLC files (not in git)
```

For working on the code (dev mode, adding a page, changing the schema, loading
step by step): [docs/development.md](docs/development.md).

## Team

INF2003 team 24: Anna, Arif, Caleb, Kessler and Sean.
