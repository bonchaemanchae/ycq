# Database design

Reference notes on how Yellow Cab Query uses PostgreSQL and MongoDB, what the
databases enforce themselves, and how the design was measured. For the import
rules and data counts, see [data.md](data.md).

## Two databases, two jobs

**PostgreSQL 16 with PostGIS** is the source of truth: every trip, zone, user
and saved plan. It enforces the rules itself, through constraints, triggers and
row-level security, and it answers the Allocation Planner.

**MongoDB 8.0** holds summaries built from PostgreSQL, each shaped for the page
that reads it, plus the saved views. The loader rebuilds them from PostgreSQL,
and after every load they are compared number by number.

One question is answered by both on purpose: the planner's per-zone, per-hour
statistics. "Check against MongoDB" in the planner recomputes them from the
time-series collection and compares every value (3,945 values for Thursday
17:00–20:00 across all boroughs, all identical).

### What's in PostgreSQL

24 tables of our own (PostGIS adds `spatial_ref_sys`, and `bench_zone_hour`
is a copy used only by the benchmark), 2 views (`v_trip_flags`,
`v_plan_summary`) and 2 materialized views (`od_summary`,
`zone_weekday_hour_fare`). `trip` is partitioned by month.

The ER diagram has all three kinds of relationship:

- **One to many:** a borough has many zones; a zone has many trips; a user
  owns many plans; a plan has many versions.
- **Many to one:** many trips come from one import; many rejected rows have
  one reason code.
- **Many to many:** users and roles, through `app_user_role`; plan versions
  and boroughs, through `allocation_plan_version_borough`.

Main tables with their key columns and types:

| Table | Columns (types, keys) |
|---|---|
| `taxi_zone` | `location_id smallint PK`, `borough_id smallint FK → borough`, `zone_name text`, `service_zone text`, `geom geometry` |
| `trip` | PK (`import_batch_id integer FK → import_batch`, `source_row_number integer`, `pickup_ts timestamp`); `dropoff_ts timestamp`, `pickup_location_id smallint FK → taxi_zone`, `dropoff_location_id smallint FK → taxi_zone`, `vendor_id smallint FK`, `payment_type_id smallint FK`, `passenger_count smallint`, `trip_distance numeric`, `fare_amount numeric`, `total_amount numeric`, `store_and_fwd_flag boolean` |
| `import_batch` | `import_batch_id integer PK`, `source_file text`, `file_month date UNIQUE`, `checksum_sha256 char UNIQUE`, `rows_read integer`, `rows_accepted integer`, `rows_rejected integer`, `status text`, `finished_at timestamptz` |
| `rejected_trip` | `rejected_id bigint PK`, `import_batch_id integer FK → import_batch`, `reason_code varchar FK → validation_code`, the raw row's values |
| `zone_hour_observation` | PK (`location_id smallint FK → taxi_zone`, `obs_hour timestamp`); `local_date date`, `local_hour smallint`, `iso_dow smallint`, `pickups integer`, `dropoffs integer`, fare, distance and duration sums and counts |
| `app_user` | `user_id integer PK`, `email text`, `display_name text`, `password_hash text`, `is_active boolean`, `created_at timestamptz` |
| `app_user_role` | PK (`user_id integer FK → app_user`, `role_id smallint FK → app_role`) |
| `account_invite` | `account_invite_id integer PK`, `user_id integer FK → app_user`, `token_sha256 text UNIQUE`, `expires_at timestamptz`, `used_at timestamptz`, `revoked_at timestamptz` |
| `allocation_plan` | `allocation_plan_id integer PK`, `owner_user_id integer FK → app_user`, `name text` |
| `allocation_plan_version` | PK (`allocation_plan_id integer FK → allocation_plan`, `version_no integer`); `fleet_size integer`, `iso_dow smallint`, `start_hour smallint`, `end_hour smallint`, `w_pickup numeric`, `w_imbalance numeric`, `w_consistency numeric`, `w_fare numeric`, `note text` |
| `allocation_plan_version_borough` | PK (`allocation_plan_id`, `version_no` FK → allocation_plan_version, `borough_id smallint FK → borough`) |
| `allocation_result` | PK (`allocation_plan_id`, `version_no` FK → allocation_plan_version, `hour smallint`, `location_id smallint FK → taxi_zone`); `proposed_taxis integer`, `final_taxis integer`, `score numeric`, `rank smallint` |
| `allocation_plan_version_seal` | PK (`allocation_plan_id`, `version_no` FK → allocation_plan_version); `prev_hash text`, `hash text`, `sealed_at timestamptz` |

### What's in MongoDB

| Collection | Kind | One document is | Documents | Used by |
|---|---|---|---:|---|
| `zone_activity_daily` | pre-summed | one zone on one day | 23,670 | Zone maps |
| `zone_activity_timeseries` | time-series, `meta` = zone and borough | one zone in one hour | 567,817 | Zone maps with hours filtered, comparing zones, the planner's MongoDB check |
| `borough_activity_hourly` | pre-summed | one borough in one hour | 12,954 | Daily trends, the planner's busiest-shift data |
| `origin_destination_snapshots` | snapshot | one zone's top 10 destinations for a month, day type and time band | 7,452 | Flow Explorer |
| `saved_analysis_views` | app data | one saved view | — | Views menu |

Four collections have strict `$jsonSchema` validators (validation level
strict, action error). MongoDB 8.0 doesn't allow validators on time-series
collections, so the loader checks every hourly document itself and removes the
month if any fail.

Example document from `origin_destination_snapshots` (Upper East Side South,
weekday mornings in March 2026; 2 of its 10 destinations shown):

```js
{
  originZoneId: 237, originBorough: 'Manhattan',
  month: '2026-03', dayType: 'weekday', timeBucket: 'am_peak',
  totalTrips: 18148, destinationCount: 126,
  destinations: [
    { rank: 1, zoneId: 236, zoneName: 'Upper East Side North', borough: 'Manhattan',
      trips: 2639, share: 0.145415, averageFare: 8.7771,
      averageDistance: 0.9662, averageDurationSec: 464.4059 },
    { rank: 2, zoneId: 161, zoneName: 'Midtown Center', borough: 'Manhattan',
      trips: 2082, share: 0.114723, averageFare: 9.6755,
      averageDistance: 1.1119, averageDurationSec: 527.5385 },
    ...
  ]
}
```

No MongoDB query in the app uses `$lookup`: each page reads one collection
shaped for it, and the Flow Explorer reads a single document.

### Which page reads which store

| Page | Store |
|---|---|
| Zone maps | MongoDB `zone_activity_daily`; `zone_activity_timeseries` when hours are filtered |
| Daily trends | MongoDB `borough_activity_hourly` |
| Flow Explorer | MongoDB `origin_destination_snapshots` |
| Views menu | MongoDB `saved_analysis_views` |
| Allocation Planner, Saved plans | PostgreSQL (`zone_hour_observation`, `zone_weekday_hour_fare`, the plan tables) |
| User management, login | PostgreSQL |
| Data health | Both |

Database evaluation → Data pipeline (steps 3 and 4) shows the same lists live,
with row and document counts (`GET /admin/stores`).

## Analytical Dashboard

One page with two sections, Zone maps and then Daily trends below it (the
sidebar's two items scroll to them). Both follow the same filters: a date
range, days of the week, a range of hours (22 to 2 wraps past midnight) and
boroughs. Any filter that is on shows as a yellow chip with its own remove
button, and the map zooms to the chosen boroughs with the rest faded.

| Section | Question | Shows |
|---|---|---|
| Zone maps | Where do people want taxis, and where do taxis run short? | Four totals: pickups a day (an hour when hours are filtered), the taxi balance (pickups minus drop-offs), the average fare with what it earns per taxi-hour, and the average trip time and distance. One map with a **Demand \| Shortages** switch: by pickups, with every zone ranked beside it, or by pickups minus drop-offs (red short of taxis, blue piling up), with the zones short of taxis and those with too many. **+** adds a zone to the comparison under the map (up to three: median and 90th percentile of hourly pickups, peak hour, fare, trip length); clicking a zone opens the Flow Explorer |
| Daily trends | How steady is demand, and which days broke the pattern? | Pickups per day or hour with a moving average; the **unusual days**, each at least 30% above or below the median of the same day of the week over the chosen dates, marked on the chart |

**From the dashboard to the planner.** **Allocate taxis →** opens the
Allocation Planner with what the dashboard is filtered to. The planner starts
on the busiest shift inside the dashboard's weekdays and hours (or on the
exact shift, when the filters name one weekday and one hour range). It takes
the boroughs too, and the zones looked at (opened in the Flow Explorer or
compared), which the plan marks as Watched. The dashboard keeps its filters
for the browser tab until logout (`planLink` in
`web/src/pages/planner/types.ts`).

**Flow Explorer.** The top 10 destinations of trips from a zone, drawn as
lines on the same map, for a month, weekday or weekend, and time band (the
snapshot closest to the filters, which can be changed), and optionally the
same slice across every month. It explains a shortage: from JFK, most trips
go to Manhattan, so JFK's taxis leave and don't come back on their own.

The dashboard reads MongoDB through these routes (each takes the filters as
query parameters, named like a saved view's filters):

| Route | What it returns | MongoDB features |
|---|---|---|
| `GET /dashboard` | Totals and every zone with its rank, share and imbalance | `$facet`, `$setWindowFields` (`$rank`, window `$sum`) |
| `GET /dashboard/series` | Pickups and drop-offs per day or hour, with a 7-day or 24-hour moving average; per day, a normal day of the same weekday and the unusual days | `$setWindowFields` (window `$avg`; window `$median` partitioned by weekday) |
| `GET /dashboard/weekdays` | Average pickups per day for each weekday, and for each weekday and hour (the planner's busiest shifts) | `$facet`, two-stage `$group` |
| `GET /dashboard/compare` | Up to three zones side by side: median and 90th percentile of hourly pickups, peak hour | `$median`, `$percentile` |
| `GET /dashboard/context` | Loaded date range, latest import and your recent plans (PostgreSQL) | — |

Averages are total sums divided by total counts, so they match PostgreSQL for
the same rows (`tests/test_dashboard.py` checks every route against
`zone_hour_observation`).

**Smallest collection first.** Each question reads the smallest of three
collections that holds what it needs (`source()` in `api/dashboard.py`). All
three are built from `zone_hour_observation` with the same field names, so the
pipelines are the same on each. Every response says which collection answered
(`source`) and how long it took (`queryMs`); an admin sees it under each
chart.

**Sums, not averages.** Activity documents hold sums and counts only
(`fareSum`, `fareTripCount` and so on); the API divides them for whatever it
adds up. They used to store the three averages too, which were `null` for an
hour without trips. In a time-series collection a field that is `null` in one
document and a number in the next closes the bucket, so the three months sat
in 169,166 buckets of about 3 measurements each, and reading them was the
slowest thing in the app. Without the averages they fit in 1,052 buckets, none
closed by a change of type. The benchmark's three-month questions on the time
series went from 1,787 and 1,919 ms to 62 and 76 ms, and the hourly map under
80 simultaneous users from 58 failed requests to none.

**A lean summary group.** The map's summary groups the documents by zone, and
that group holds nothing but sums. It used to take each zone's borough with
`$first` and collect each zone's dates with `$addToSet` to count the days. On
the time series those two cost more than the eight sums together (64 ms for the
sums alone, 157 ms with both). The borough is now part of the group's key, and
the days are counted by a second, small query on the borough-hour documents
(`days_pipeline` and `days_source` in `api/dashboard.py`). With an hour filter
over three months the map went from about 3 requests a second to 12 for one
user and 27 to 29 for 20 to 80 users, and the 95th percentile response at 80
users from 28 seconds to 3.3.

A database loaded with the old layout is rebuilt by itself: the loader drops
the three activity collections if they still hold averages
(`drop_old_layouts` in `etl/load_mongo.py`) and loads them again from
PostgreSQL, about 40 seconds for three months.

## Allocation Planner

**Build a plan:** the weekday, from and to, how many taxis and the boroughs,
the five things a fleet manager decides, in one row. The planner opens on the
busiest shift, and every change works the plan out again
(`POST /plans/preview`). How zones are ranked is fixed at the defaults
(pickup activity 0.50, net outflow 0.25, consistency 0.15, median fare 0.10,
up to 10 zones an hour); they are stored with every version, PostgreSQL checks
the weights add up to 1, and only admins see them.

**Your plan:** a row per zone and a column per hour, every number editable,
each hour's total under it. Every hour must add up to the fleet; **Fix** puts
the difference right. The planner **recommends** the top zones each hour among
those with at least 30 pickups at that hour over the loaded weeks, and splits
the taxis in proportion to score × average pickups, so a zone with twice the
pickups gets about twice the taxis. It **allows** any zone of the chosen
boroughs; the database refuses zones outside them. The Taxis box starts, in
grey, at the demand of the shift's busiest hour: the plan's zones' pickups an
hour times the average trip time (Little's law). For admins, **Why?** on a
zone shows the numbers behind its ranking. **Save plan** saves it as a new
plan or a new version of one, sealed for good.

**The ranking query** (`SCORE_SQL` in `api/planner.py`) is one SQL statement:
eight chained CTEs.

| CTE | What it does |
|---|---|
| `stats` | Per zone and hour on the chosen weekday: days observed, trips, average pickups, average net outflow, standard deviation (`count`, `sum`, `avg`, `stddev_pop`) |
| `candidates` | Marks zones with enough trips as reliable, works out consistency, joins the median fare from the `zone_weekday_hour_fare` materialized view; a nested `EXISTS` keeps only zones with a map shape |
| `percentiles` | Each measure as a percentile within its hour, `cume_dist() OVER (PARTITION BY hour, reliable ORDER BY ...)` |
| `scored` | The weighted sum of the four percentiles |
| `ranked` | `row_number() OVER (PARTITION BY hour ORDER BY reliable DESC, score DESC, ...)` |
| `weighted` | Each hour's demand total over the chosen zones, `sum(...) FILTER (WHERE ...) OVER (PARTITION BY hour)` |
| `shares` | Each zone's exact share of the fleet |
| `floored` | The largest-remainder split: whole taxis first, then the leftover to the largest remainders, so every hour adds up exactly |

**Backtest.** `etl/backtest_planner.py` builds plans from January and February
only and scores them on March. Share of March's taxi shortage that falls in
zones given taxis: planner 69.3%, busiest zones 61.3%, random zones 3.8%. The
planner covers more shortage than "busiest zones" in 148 of 168 weekday-hours,
at a small cost in plain pickup coverage (36.2% against 38.8%).

## Saved views

The **Views** menu beside the dashboard filters: name what you are looking at
and save it, open it again later, save changes into it, rename it or delete
it. Views are each user's own and live in MongoDB (`saved_analysis_views`), so
this is the app's CRUD on the NoSQL side, as plans are on the PostgreSQL side.

| Route | What it does |
|---|---|
| `GET /views?page=dashboard` | Your views, newest first (optionally one page's) |
| `POST /views` | Save `{name, page, filters, widgets}` |
| `GET /views/{id}` | One view |
| `PATCH /views/{id}` | Rename, or store the page's new filters or widgets. With `expectedUpdatedAt`, 409 if the view changed since |
| `DELETE /views/{id}` | Delete it |

`filters` are the page's own, defined once in `api/filters.py`, and MongoDB's
`$jsonSchema` validator is generated from the same definition. `widgets` is
free-form: the dashboard keeps its section, compared zones, chart bucket and
the open Flow Explorer slice there. A zone or borough is checked against
PostgreSQL before a view is saved, since MongoDB can't hold a foreign key into
it.

**Optimistic concurrency.** Two tabs can have the same view open. The panel
sends the `updatedAt` it loaded with every change, and MongoDB makes the change
only if the view still has it (one atomic `find_one_and_update`); otherwise the
API answers 409 and the panel loads the view again, so the second save can't
silently undo the first. No lock is held while editing.

## Rules the database enforces

### Integrity constraints

- `import_batch`: `UNIQUE (file_month)` and `UNIQUE (checksum_sha256)`, so a
  month or file loads once; `CHECK (rows_accepted + rows_rejected = rows_read)`.
- `trip`: `CHECK (dropoff_ts >= pickup_ts)`, `CHECK (passenger_count >= 0)`.
- `zone_hour_observation`: hours 0–23, weekdays 1–7, pickups and drop-offs not
  negative.
- `allocation_plan_version`: `CHECK (w_pickup + w_imbalance + w_consistency +
  w_fare = 1)`, fleet size above 0, start hour not after end hour.
- `allocation_plan`: `UNIQUE (owner_user_id, name)`.
- Seals and invitation tokens must be 64 hexadecimal characters.

### Saved plans (triggers)

Ten triggers check saved allocation plans in the database itself, not only in
the API (`sql/006`, `011`, `012`, `017`), four of them as deferred constraint
triggers that run at commit:

- every hour of a version adds up exactly to the fleet size, and no hour in the
  version's range is missing;
- every result's zone has a map shape and is in one of the version's boroughs;
- a saved version, its boroughs and its results can't be updated or deleted on
  their own. Changes are saved as a new version, and deleting the plan removes
  all its versions;
- a saved version takes no more rows.

### Hash chain

Those triggers stop the API, but the database owner could switch one off, edit
a row and switch it back on. So each version is sealed when it is committed
(`sql/017`): `allocation_plan_version_seal` holds a SHA-256 of the version's
settings, boroughs and results together with the hash of the version before
it, so a plan's versions form a chain. Editing a version changes what its hash
should be, and replacing its seal to match breaks the next version's link.

- Saved plans shows ✓ Verified on each version, or a warning if it no longer
  matches.
- Administration → Data health recomputes every hash each time it opens
  (`GET /admin/plan-seals`).
- In psql: `SELECT * FROM plan_seal_check() WHERE problem IS NOT NULL;`

The API's login can read seals but not write them; the sealing trigger runs
with the owner's rights. The chain can't show a rewrite of a version and every
seal after it, or the removal of a plan's newest version, unless someone kept
a copy of the latest hash.

## Users, login and security

Database-enforced first:

- **Row-level security on plans** (`sql/016`): policies `plan_read` and
  `plan_write` on the five plan tables. For each request the API tells
  PostgreSQL who is calling (`app.user_id`, set in `api/auth.py` and cleared
  when the connection goes back to the pool in `api/db.py`). A plan, its
  versions and results can be read by their owner or an active admin, and
  changed only by their owner; with no user set nothing is visible. So even a
  query that forgot `WHERE owner_user_id = ...` would only reach the caller's
  plans. `v_plan_summary` uses `security_invoker` so the view doesn't skip the
  rules. The owner role bypasses them, so the loader and tests are unaffected.
- **Restricted database logins** (`sql/015`): the API never connects as the
  owner. Its PostgreSQL login (`ycq_app`, a member of `ycq_write`) reads every
  table but writes only users, the four plan tables and invitations. It can't
  create, alter or drop anything, delete accounts, or touch trips, imports and
  summaries. `ycq_read` is the same without the writes.
  `tests/test_db_roles.py` runs the whole app as such a role and checks what
  it is refused.
- **MongoDB role:** the API's MongoDB login holds only the custom role
  `ycqApp` (`etl/load_mongo.py`): it reads every collection in `ycq` and
  inserts, updates and deletes only in `saved_analysis_views`.
- **One open invitation per account:** the partial unique index
  `account_invite_one_open ON account_invite (user_id) WHERE used_at IS NULL
  AND revoked_at IS NULL`.

Then the application:

- **Accounts:** the three default accounts are created by the loader from
  `.env` (`scripts/seed_users.py`). There is no self sign-up.
- **Inviting** (Administration → User management): an admin enters an email,
  a name and a role, never a password. The API creates the account with no
  password (`password_hash` is NULL, so nothing can log in to it) and emails a
  one-time link (`api/mailer.py`) to `/setup#<token>`, where the person sets
  their own password and is logged in. Only the token's SHA-256 hash is stored
  (`account_invite`, `sql/019`). A link works once, expires after 48 hours,
  and stops working when a newer link replaces it or the account is disabled.
  The token sits after `#`, which browsers never send to a server, so it stays
  out of web server logs. User management also shows the link to copy, in case
  the email fails.
- **Email:** in Docker Compose the API sends to Mailpit
  (http://localhost:8025). To send real email, set `SMTP_HOST` and `SMTP_PORT`
  to a real mail server and `APP_URL` to where the website is.
- **Passwords** are stored as Argon2id hashes. Logging in returns a token valid
  for 8 hours; the website keeps it until the tab is closed. Roles and whether
  the account is still active are checked on every request, so changes apply
  at once.
- **Roles:** fleet managers (role `analyst`) use every page except
  Administration and Database evaluation; admins use all of them.
- **Disabling a user** stops their login and every session they hold at once,
  and revokes any open invitation. Their saved plans (and the hash chain over
  them) and saved views are kept, and an admin can enable the account again.
  Accounts are never deleted from the app. You can't disable yourself, and the
  last admin who can log in can't be disabled.

## Checks across both databases

- **Reconciliation** (`etl/reconcile.py`, after every load): recomputes every
  number in every MongoDB document from PostgreSQL (hourly zone documents, the
  pre-summed documents, and each flow snapshot's totals, order, trips, shares
  and averages). The result is stored in `reconciliation_run`; all three
  months pass.
- **Orphaned saved views:** a saved view's owner is a PostgreSQL user, a link
  no foreign key can hold. Administration → Data health checks, live, whether
  every view's owner still exists, and can delete views whose owner is gone
  (`GET`/`DELETE /admin/orphaned-views`); each reconciliation run records it
  too. The app never deletes users, so it never leaves orphans; a user deleted
  straight in `psql`, or one database restored without the other, can.
- **Backups:** saved views live only in MongoDB, so back them up with
  `mongodump`.

## Evaluation tools

All four only read data. Run them after every month is loaded, after
`docker compose build loader` if the scripts changed.

### Speed benchmark

```bash
docker compose run --rm loader python etl/benchmark.py                 # 50 timed runs per query
docker compose run --rm loader python etl/benchmark.py --runs 10       # quicker
docker compose run --rm loader python etl/benchmark.py --zone 237      # another zone for Q1, Q2, Q5
docker compose run --rm loader python etl/benchmark.py --explain-summary 2026-01
```

It copies the hourly summaries into three benchmark stores with equivalent
indexes (`bench_zone_hour` in PostgreSQL, `bench_zone_hour_collection` and
`bench_zone_hour_timeseries` in MongoDB) and runs the app's own questions:

| Query | Question | Stores |
|---|---|---|
| Q1 | One zone, one hour | PostgreSQL, MongoDB collection, MongoDB time-series |
| Q2 | One zone over seven days | same |
| Q3 | Totals for every zone over a month | same |
| Q4 | Top 10 zones by pickups over a month | same |
| Q5 | Top 10 destinations for one origin, month, day type and time band (the Flow Explorer) | PostgreSQL `od_summary` against one MongoDB document |
| Q6 | Every zone's totals over three months (the dashboard) | `zone_hour_observation`, the time series, the pre-summed collection |
| Q7 | Pickups by weekday and hour over three months | same |

It records a cold run, the median and 95th percentile of the timed runs, data
and index size, load time and each query plan, and saves them to
`benchmark_run` only if every store gave the same answers. The latest results
appear under Database evaluation → Performance. `--explain-summary` prints
`EXPLAIN ANALYZE` of one month's summary build and changes nothing.

Results (15 Nov 2026, medians of 50 runs):

| Query | PostgreSQL | MongoDB collection | MongoDB time-series | MongoDB pre-summed |
|---|---:|---:|---:|---:|
| Q1 | **0.12 ms** (4 pages) | 0.40 ms (1 document) | 0.91 ms (1 bucket) | |
| Q2 | **0.37 ms** | 1.09 ms | 1.44 ms | |
| Q3 | **18.2 ms** | 116.3 ms (195,409 documents) | 21.5 ms (789 buckets) | |
| Q4 | 13.4 ms | 91.2 ms | **9.27 ms** | |
| Q5 | **0.15 ms** | 0.34 ms (1 document) | | |
| Q6 | 33.2 ms (7,359 pages) | | 43.8 ms | **18.9 ms** |
| Q7 | 29.1 ms (7,359 pages) | | 60.1 ms | **9.28 ms** |

Sizes (data and indexes): hourly summaries 82.3 MB in PostgreSQL, 55.9 MB as a
MongoDB collection, 4.3 MB as a time series (19 times smaller), which takes 2.0
times as long to load (7.7 s against 3.8 s). Flow Explorer data 69.4 MB in
PostgreSQL against 9.6 MB in MongoDB. The pre-summed dashboard collections take
2.6 MB and 1.6 MB.

### Load test

```bash
docker compose run --rm loader python etl/load_test.py
docker compose run --rm loader python etl/load_test.py --only flow --users 49 50 --seconds 6
docker compose exec postgres psql -U ycq -d ycq -c "SELECT question, users, requests_per_sec, median_ms, p95_ms, failed FROM load_test_run WHERE run_at = (SELECT max(run_at) FROM load_test_run) ORDER BY load_test_run_id"
```

Sends real requests to the running API from 1, 5, 10, 20, 50 and 80
simultaneous users, 15 seconds each, for five features: the daily map, the
hourly map, the weekday chart, the Flow Explorer and the planner preview. Each
user logs in as `analyst1@ycq.local` and waits for each answer before sending
the next. It reports requests a second, median and 95th percentile response
times and failures, saves them in `load_test_run` (`--no-save` skips this),
and takes about 10 minutes. The Performance page shows the latest full run, so
run every feature together. The API and the test share one machine, so
compare the ratios rather than the absolute numbers.

### Planner backtest

```bash
docker compose run --rm loader python etl/backtest_planner.py
docker compose run --rm loader python etl/backtest_planner.py --fleets 50 200 500
```

Makes plans from January and February with the real planner code (temporary
tables hold only the training months, so no March number can reach a plan),
then scores them on March against "busiest zones" and random zones: coverage,
fit, share of the shortage covered, and taxis in use. Nothing is saved.

### Design evidence

```bash
docker compose run --rm loader python etl/evidence.py
docker compose run --rm loader python etl/evidence.py --only buckets
```

Builds its one experiment in a scratch MongoDB database that it drops
afterwards, and takes about a minute.

| Part | What it measures | Result (26 Nov 2026) |
|---|---|---|
| `buckets` | The hourly documents copied into two time-series collections: with averages that are `null` for an hour without trips, and with sums and counts only, as stored | 169,166 buckets against 1,052; load 28.0 s against 14.1 s; dashboard summary 2,590 ms against 103 ms |
| `routing` | The dashboard's three questions over every loaded month, on the hourly time series and on the pre-summed collection the API picks, with the answers compared | 103, 379 and 154 ms against 39, 22 and 25 ms; answers the same |
| `timestamp` | The same totals with dates matched on `localDate` and on the time series' own `timestamp` | 38 ms against 26 ms; answers the same |
| `plans` | PostgreSQL's `EXPLAIN ANALYZE` for a week of trips and for the planner's statistics, and MongoDB's execution statistics for the dashboard and Flow Explorer reads | A week of March trips reads only the March partition (80 ms); the planner's statistics use an index (6.6 ms); the Flow Explorer examines 1 document |
