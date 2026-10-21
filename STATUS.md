# YCQ project status

Team 24, as of 16 October 2026 (week 7). Owners are taken from the progress
report's Gantt chart. Everything under **Done** was checked by running it: 54
automated tests pass, and the full stack was run on the real January–March 2026
data (10,982,814 accepted trips). Anything not checked that way is listed
under **Not done**.

How to build, run and change things is at the end:
[Working on the project](#working-on-the-project).

---

## Not done yet

### Kessler: Activity Dashboard (W7–W11)

*Report: "A filtered zone map with top zones, imbalances, hourly charts and
comparisons … write `$facet` and `$setWindowFields` pipelines, then the map and
charts."*

- [ ] API routes for the dashboard, querying **MongoDB** with `$facet` and `$setWindowFields`
- [ ] The page: filters, zone map, top zones, imbalances, hourly charts, comparisons
- [ ] A chart library. Only the map library is installed. Add one to
  `web/package.json` (for example `recharts`), then `docker compose restart web`
  in dev mode
- [ ] Optional, suggested by the review: `$median` / `$percentile` over hourly
  pickups for zone comparisons. It adds to the MongoDB side, which is the
  project's weaker half

**Where:** backend [api/routers/dashboard.py](api/routers/dashboard.py), page
[web/src/pages/Dashboard.tsx](web/src/pages/Dashboard.tsx), shared map
[web/src/components/ZoneMap.tsx](web/src/components/ZoneMap.tsx). Both files
have a TODO and an example route to replace.

**Data ready to use:** MongoDB `zone_activity_timeseries`: 567,817 hourly
documents with pickups, drop-offs, imbalance, and fare, distance and duration
sums and averages. It has indexes on `{meta.zoneId, timestamp}`,
`{localDate, localHour}` and `{isoDayOfWeek, localHour}`. Reconciliation checks
every one of these numbers against PostgreSQL. In the API, use `mongo()` from
[api/db.py](api/db.py).

### Caleb: Flow Explorer (W8–W11) and Saved Views (W8–W10)

*Report: "Top ten destinations from a zone by month, day type and time of day
… query them with `$unwind` and draw map lines." Saved Views: "save, reopen,
rename and delete filter sets … owner-only CRUD endpoints, with save and open
buttons."*

- [ ] Flow Explorer API routes using `$unwind` on `origin_destination_snapshots`
- [ ] Flow Explorer page with destination lines on the map
- [ ] Saved Views: create, rename and delete routes (listing already exists),
  always filtered by the logged-in owner
- [ ] Save and open buttons on the Dashboard and Flow Explorer pages
- [x] When a user is deleted: their MongoDB views are deleted **first**, then
  the PostgreSQL user (`api/users.py`, `DELETE /admin/users/{id}`). Uses
  `delete_views_for_user` from `api/saved_views.py`

**Where:** [api/routers/flows.py](api/routers/flows.py),
[web/src/pages/Flows.tsx](web/src/pages/Flows.tsx),
[api/routers/saved_views.py](api/routers/saved_views.py).

**Data ready to use:** `origin_destination_snapshots`: 7,452 documents, one per
origin zone × month × day type × time bucket, each with an embedded top-10
`destinations` list (rank, zone, trips, share, averages). The
`saved_analysis_views` collection has a `$jsonSchema` validator
(`additionalProperties: false`, `page` must be `"dashboard"` or `"flows"`) and
a **unique** index on `{ownerUserId, name}`, so duplicate names are refused by
the database.

### Arif: Users and Security (W8–W9)

*Report: "Login with analyst and administrator roles … Argon2 password hashing,
token login, role checks and input validation."*

- [x] Argon2id password hashing and `POST /auth/login` returning an 8-hour JWT
  signed with `JWT_SECRET` (the API refuses to start if it's under 32
  characters). `GET /auth/me`. Default accounts from `.env`
  (`scripts/seed_users.py`, run by the loader)
- [x] `current_user` in [api/auth.py](api/auth.py) reads the token and reloads
  the user and roles from PostgreSQL on every request. The dev user is gone
- [x] Role checks: routers are grouped in `api/main.py` (public / analyst or
  admin / admin only); `tests/test_auth.py` calls every route to check it
- [x] Login page ([web/src/pages/Login.tsx](web/src/pages/Login.tsx)), token
  sent from [web/src/api.ts](web/src/api.ts), Administration only shown to admins
- [x] Deleting a user across both databases, with a Users section on the
  Administration page (review §3.2)
- [x] Admins add analyst or admin accounts in the same Users section
  (`POST /admin/users`); the three default emails stay with `.env`
- [ ] PostgreSQL read/write roles, if you build them. **Use `sql/014_…`:**
  `012` and `013` are now taken. Remember the admin rebuild (review §3.1): the
  rebuild writes `reconciliation_run` and the summaries, so either give admin
  routes a role that can do that, or keep rebuilds as scripts

**Data ready to use:** tables `app_user` (case-insensitive unique email),
`app_role` (`analyst`, `admin`) and `app_user_role` (many-to-many).

### Sean: Administration and benchmarks (W11–W12)

*Report: "Shows imports, rejections, reconciliation and benchmark results …
benchmark four queries in PostgreSQL and two MongoDB collections using query
plans, and build the admin page."*

- [x] Administration page and routes (`GET /admin/imports`, `/admin/rejected`,
  `/admin/reconciliation`, admin role only): imports (`import_batch`), reject
  and warning reasons, rejected rows 50 per page (`rejected_trip`),
  reconciliation runs (`reconciliation_run`). Tests in `tests/test_admin.py`
- [x] Benchmark script `etl/benchmark.py`: the hourly summaries copied into a
  PostgreSQL table, a normal MongoDB collection and a MongoDB time-series
  collection with equivalent indexes; four queries, plus a fifth for the Flow
  Explorer's top 10 destinations (`od_summary` vs `origin_destination_snapshots`,
  added to the master plan); a cold run plus 50 timed runs each (median and 95th
  percentile), data and index size, load time and query plans (`EXPLAIN ANALYZE`,
  MongoDB `explain`), saved to `benchmark_run` only if every store gives the same
  answers. Tests in `tests/test_benchmark.py`
- [x] Benchmark results on the Administration page (`GET /admin/benchmarks`)
- [x] `EXPLAIN ANALYZE` of a summary build: `python etl/benchmark.py --explain-summary 2026-01`
  (rolled back, changes nothing)
- [ ] Run the benchmark on the final machine and write up the results for the report

**Where:** [api/routers/admin.py](api/routers/admin.py),
[web/src/pages/Admin.tsx](web/src/pages/Admin.tsx), scripts in [etl/](etl/).

### Everyone: final report, slides and video (W13)

- [ ] **Redraw the ERD from the real database.** The progress report's ERD is
  out of date: one role per user, a warnings text column, a surrogate plan
  version key, and missing tables. In DBeaver, connect to `localhost:5432`,
  right-click the `public` schema and choose **View Diagram**
- [ ] **Update the numbers.** The progress report says 6,000 rejected and 162,872
  warned. Current January figures: 3,683,870 accepted, 41,019 rejected (35,048
  of them R7 reversals), 191,613 warned. All months are in the
  [README results table](README.md#results-january-to-march-2026)
- [ ] Say why MongoDB rather than another NoSQL database. So far it's only
  compared with Access (review §3.4)
- [ ] Planner wording: it ranks with **percentiles** (`cume_dist`), not
  min-max scaling. A zone with no median fare counts as fare 0 and its reason
  says "median fare unknown"
- [ ] Quote the real MongoDB 8.0 error for validators on time-series
  collections: `InvalidOptions: 'timeseries' is not allowed with 'validator'`
- [ ] "Winter Storm Fern" is unverified. The README only says "two blizzards"
- [ ] The submission zip must include `data/` (185 MB), per the brief

---

## Done and verified

### Infrastructure and website template

- [x] One command (`docker compose up -d --build`) builds and starts PostgreSQL
  16 + PostGIS, MongoDB 8.0, the loader, the FastAPI backend and the React
  website
- [x] Dev mode ([docker-compose.dev.yml](docker-compose.dev.yml)): saved changes
  to `api/` and `web/` show without rebuilding. Tested by editing a route and a
  page
- [x] Pages named as in the report: Activity Dashboard, Flow Explorer,
  Allocation Planner, Administration. Each has its own backend router and page
  file
- [x] The website header shows whether both databases are up and which months
  are loaded
- [x] The API logs in to MongoDB as `ycq_app` (read/write on `ycq` only), not
  root. Checked: it's refused when it tries to read the admin users or write to
  another database
- [x] [README.md](README.md) is the user manual the brief asks for: setup,
  everyday commands, dev mode, database work, troubleshooting

### Data import and validation 

- [x] All three official TLC months imported and checked by SHA-256. Every count
  matches the README table, as confirmed independently by the team's review
- [x] Reject rules R1–R9 and warnings W1–W9. **R8** (unknown vendor, payment
  type or rate code) and **R9** (impossible value: negative passengers, or a
  number out of range or NaN/infinity) are new: such a row is now rejected on
  its own instead of aborting the whole month. Neither changes the three real
  months' counts (checked: no such values among the accepted trips)
- [x] Zone files are checksummed too, not just the trip files
- [x] Hourly summaries, including the 23-hour daylight-saving day, and
  origin-destination summaries. The materialised views refresh `CONCURRENTLY`,
  so reads aren't blocked
- [x] MongoDB loaded: time-series collection, embedded destination lists,
  `$jsonSchema` validators, unique indexes
- [x] **Reconciliation checks every number in every MongoDB document** (12 per
  hourly document, plus each destination's trips, share, averages and rank)
  against PostgreSQL. All three real months PASS, and tests confirm a hand edit
  to an average, sum or share is caught
- [x] [etl/delete_month.py](etl/delete_month.py) removes one month so it can be
  re-imported, keeping users, plans and saved views. Before, the only way was
  `docker compose down -v`, which wipes everything

### Allocation Planner 

Everything the report lists for this part is built and tested.

- [x] Scoring: four percentiles per zone and hour (pickup activity, net outflow,
  consistency, median fare) from all loaded months, with adjustable weights
- [x] The fleet split by largest remainder, so every hour adds up exactly
- [x] Analyst adjustments: change taxis per zone, add or remove zones (from the
  list or by clicking the map), and a per-hour "left to place / too many"
  counter with a one-click fix
- [x] Plans: create, list, open, rename and delete. Versions: save (with a
  note), list, open and compare
- [x] Saving is one transaction, with a row lock so two saves can't take the
  same version number
- [x] **Rules enforced by the database itself:** every hour adds up to the fleet
  and none is missing (deferred constraint triggers); each result's zone is in
  the version's boroughs and has a map shape; saved versions can't be edited
  or deleted on their own ([sql/012_plan_integrity.sql](sql/012_plan_integrity.sql)).
  The review's attack (`UPDATE allocation_plan_version SET fleet_size = 50`) is
  now refused
- [x] **PostgreSQL vs MongoDB check:** the planner's statistics are computed in
  both databases, compared value by value and timed. On the real data, all
  31,560 values were identical across every borough for a whole Monday.
  PostgreSQL took about 57 ms and MongoDB about 435 ms (median of 5 runs, after
  adding a matching weekday/hour index to MongoDB). Shown on the planner page
  with both queries
- [x] Owner-only access in every query, and 15 planner tests plus 17
  database-rule tests

### Team review (YCQ_REPO_REVIEW.md)

| Item | Status |
|---|---|
| P1 Saved versions could be edited into breaking their rules | Fixed (`sql/012`), tested |
| P2 Results could use zones outside the plan's boroughs | Fixed (`sql/012`), tested |
| P3 Reconciliation only checked counts | Fixed: every field checked, tested |
| P4 Re-importing destroyed users, plans and views | Fixed (`delete_month.py`), tested |
| P5 One unknown code aborted the whole month | Fixed (R8), tested |
| P6 Missing median fares | Handled in the planner, tested |
| P7 Blocking refresh, root MongoDB login, unpinned zone files, Unknown/N/A boroughs | Fixed |
| P7 `v_trip_flags` cost | Open: an `EXPLAIN ANALYZE` for the benchmark write-up (Sean) |
| §3.1 Write role vs admin rebuild | Open (Arif / Sean): those parts aren't built yet |
| §3.2 Deleting a user across two databases | Fixed: `api/users.py` (deactivate, MongoDB views, PostgreSQL user; saving a view locks its owner's row) |
| §3.3 MongoDB side lighter than PostgreSQL | In progress: Dashboard and Flow Explorer (Kessler, Caleb) |
| §3.4 "Why MongoDB" justification | Open: report (everyone) |

---

## Working on the project

All commands run from the `ycq` folder (the one with `docker-compose.yml`). You
only need Docker Desktop. Full details are in [README.md](README.md).

### First time

```bash
git clone https://github.com/bonchaemanchae/ycq.git
cd ycq
cp .env.example .env            # PowerShell: Copy-Item .env.example .env, then set the passwords
docker compose up -d --build    # first start loads the data: about 5 minutes per month
docker compose logs -f loader   # wait for "all loaded"
```

Then open **http://localhost:8080** (the website) and
**http://localhost:8000/docs** (the API, where you can try every route).

### While you work on your page

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Edit your files in `api/` or `web/`, save, and refresh the page. No rebuild is
needed. Before you push, check the real build once:
`docker compose up -d --build`, then click through your page.

To add your work:

- **Backend:** add routes to your file in `api/routers/`. Use
  `conn=Depends(get_pg)` for PostgreSQL, `mongo()` for MongoDB, and
  `user: User = Depends(current_user)` for the caller
- **Frontend:** call `api("/your/route")` from `web/src/api.ts`, leaving off the
  `/api` prefix

### Database changes

| To | Do |
|---|---|
| Add a table, view, trigger or index | A **new** numbered file in `sql/` (next free number: `014`), written to be safe to re-run. Then `docker compose up -d --build loader` |
| Change MongoDB validators or indexes | Edit `ensure_collections` in `etl/load_mongo.py`, then `docker compose up -d --build loader` |
| Re-import a month after changing an import rule | `docker compose run --rm loader python etl/delete_month.py --month 2026-01`, then `docker compose up -d` |
| Look at the data | `docker compose exec postgres psql -U ycq -d ycq`, or DBeaver at `localhost:5432` and MongoDB Compass at `localhost:27017` |
| Run the tests | `docker compose build loader` then `docker compose run --rm loader pytest tests` (all 56 should pass) |
| Stop | `docker compose down` (data is kept). Never use `down -v` unless you mean to delete everything |

### Git

```bash
git switch main && git pull
git switch -c <your-name-or-feature>
# ...work, test...
git add . && git commit -m "Describe the change"
git push -u origin <your-name-or-feature>
```

Then open a pull request into `main` on GitHub and ask a teammate to review it.
