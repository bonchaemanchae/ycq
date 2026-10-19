# INF2003 Database Systems: Master Technical Specification and Architecture Plan (YCQ / Traxio)

**Module:** INF2003 Database Systems  
**Project:** Yellow Cab Query (YCQ), NYC TLC Fleet Decision Support System  
**Alternate name in the supplied specification:** Traxio; the current application uses YCQ  
**Code baseline reviewed:** `0ca7a72` (includes the four feature merges on 18 October 2026)  
**Architecture:** PostgreSQL 16 + PostGIS 3.4, MongoDB 8.0, FastAPI and React

**Original document version:** Final Master Plan (16 October 2026 Code Baseline).
The original design remains the target specification; the later code baseline
above is used only for implementation-status notes.

> **How to read this document**
>
> This document separates the group's intended scope from the current code.
> **Built** means implemented in the reviewed repository; it does not mean ready
> for production. **Partial** means some layers exist. **Planned** means not yet
> implemented. **Optional** means outside the committed core scope in this document.
> Examples are illustrative unless explicitly identified as measured results.
>
> **This is a master plan, not just an inventory of finished code.** Planned
> capabilities remain part of the intended design even when no implementation
> exists yet. Current-code notes qualify their status; they do not remove them
> from the group's goals. Original estimates and measurements are retained with
> their evidence limitations rather than silently discarded.

## Contents

1. [System overview and goals](#1-system-overview-and-goals)
2. [Container architecture](#2-container-architecture)
3. [Features, ownership and current status](#3-features-ownership-and-current-status)
4. [Dataset and ingestion pipeline](#4-dataset-and-ingestion-pipeline)
5. [PostgreSQL schema and integrity](#5-postgresql-schema-and-integrity)
6. [MongoDB collections and document design](#6-mongodb-collections-and-document-design)
7. [Fleet allocation model](#7-fleet-allocation-model)
8. [API reference: implemented versus proposed](#8-api-reference-implemented-versus-proposed)
9. [Performance comparison and evidence](#9-performance-comparison-and-evidence)
10. [Open decisions and outstanding deliverables](#10-open-decisions-and-outstanding-deliverables)

---

## 1. System overview and goals

YCQ supports NYC taxi fleet analysts and transportation administrators using
historical TLC yellow taxi trip records for January to March 2026. It turns raw
trips into zone activity summaries, origin-destination snapshots and saved fleet
allocation scenarios.

**These are historical planning scenarios, not live taxi availability, unmet
passenger demand, forecasts or guaranteed earnings.**

### 1.1 Core objectives

- **Demonstrate two complementary database models.** PostgreSQL is the
  authoritative store for trips, spatial zones, users and allocation plans.
  MongoDB serves derived hourly activity, embedded destination lists and saved views.
- **Make ingestion reproducible.** Download checksum-pinned files, classify
  invalid records, retain rejection reasons, attach warnings and reconcile
  PostgreSQL summaries with MongoDB.
- **Support spatial exploration.** Show zone activity and destination flows
  through maps, filters and comparisons.
- **Support deterministic fleet planning.** Score historical zone statistics
  using weighted percentiles and split a fleet using the largest remainder method.
- **Explain data quality and database trade-offs.** Expose imports,
  reconciliation and equivalent-answer benchmark results.

### 1.2 Intended users and boundaries

| Role          | Intended capabilities                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Analyst       | Explore activity and flows; preview, edit and save plans; manage saved views.                                 |
| Administrator | All analyst capabilities, plus import history, rejected-row inspection, reconciliation and benchmark results. |

**Current authentication limitation:** requests use `dev@ycq.local`, not a real
login session. Administration checks the user's admin role, but the development
user is assigned the available roles. JWT login and Argon2 password verification
remain planned. See [api/auth.py](api/auth.py).

**Out of scope:** machine learning predictions, real-time GPS tracking, live
booking or payments, mobile apps and a third database.

---

## 2. Container architecture

The project defines five Compose services. The loader is a one-shot job, not a
permanently running web service.

```text
NYC TLC files: Parquet trips + zone lookup CSV + zone shapefile ZIP
                              |
                              v
                           loader
          download -> validate -> import -> build summaries
                    |                         |
                    v                         v
            PostgreSQL / PostGIS           MongoDB
            authoritative data         derived documents
                    |                         |
                    +-----------+-------------+
                                |
                                v
                         FastAPI backend
                                ^
                                |
                      /api/* reverse proxy
                                |
                                v
                       React web interface
```

Reconciliation compares the derived data in the two databases. It checks the
implemented summary fields and destination snapshots; it is not a guarantee
about every possible data property or the truth of the original TLC records.

### 2.1 Services and default host access

| Service    | Technology or image                         | Default host access                      |
| ---------- | ------------------------------------------- | ---------------------------------------- |
| `postgres` | `postgis/postgis:16-3.4`                    | `localhost:5432`                         |
| `mongo`    | `mongo:8.0`                                 | `localhost:27017`                        |
| `loader`   | Python 3.12 image built from the repository | No published port; inspect loader logs.  |
| `api`      | FastAPI and Pydantic on Python 3.12         | `http://localhost:8000`; docs at `/docs` |
| `web`      | React 18, TypeScript and Leaflet            | `http://localhost:8080`                  |

### 2.2 Responsibilities and execution modes

- **PostgreSQL:** staging, validated trips, spatial polygons, user/role records,
  allocation plans and administrative records.
- **MongoDB:** hourly activity, origin-destination snapshots and saved filter states.
- **Loader:** downloads files, checks SHA-256 hashes, applies SQL, loads zones,
  imports missing months, builds summaries, populates MongoDB and reconciles.
  Fully loaded months are skipped.
- **API:** reads both databases and handles plan/view writes. Real JWT
  authentication is not implemented.
- **Web, normal mode:** Vite builds the frontend; Nginx serves it and proxies
  `/api/*` to FastAPI.
- **Web, development mode:** Node.js 22 runs Vite with mounted source files and
  an API proxy. The API also reloads mounted source files.

Recharts is **not installed**. Leaflet is the existing map library; choosing an
additional chart library remains part of the unfinished dashboard work.

### 2.3 Target architecture retained from the original plan

The intended deployment starts all five services with
`docker compose up -d --build`. PostgreSQL and MongoDB provide the dual-database
framework; the loader coordinates ingestion and derived-data reconciliation.

| Component     | Original target responsibility                                                                                 | Current implementation note                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Loader        | Python 3.12 with Polars, PyArrow, psycopg, PyMongo and pyshp; process Parquet, CSV and shapefiles.             | The one-shot loader implements this pipeline.                                                                                     |
| API           | FastAPI and Pydantic; read both databases and enforce JWT authentication and role-based access control (RBAC). | JWT authentication remains planned; the current identity is a development user.                                                   |
| Web           | React 18, TypeScript, Vite, Leaflet and Recharts; interactive maps, chart dashboards and scenario management.  | Leaflet is installed; Recharts is the original proposed chart library, not an installed dependency or a finalized library choice. |
| Reverse proxy | Nginx serves the normal-mode frontend on container port 80 and forwards `/api/*`.                              | Host access defaults to port 8080; development mode uses Vite instead.                                                            |

The original phrase "100% data fidelity" expresses the goal that copied
summaries agree completely. It is implemented through field-by-field
reconciliation of the defined summary outputs, not proof that every raw record
is correct.

Sources: [Compose services](docker-compose.yml),
[development overrides](docker-compose.dev.yml),
[frontend dependencies](web/package.json) and [setup guide](README.md).

---

## 3. Features, ownership and current status

### 3.1 Core scope

| Feature              | Owner   | Backend status                                                                            | Website status                                                                     |
| -------------------- | ------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Login and roles      | Arif    | **Partial:** user/role schema and development-user dependency; real login is **planned**. | **Planned:** login page and token handling.                                        |
| Activity Dashboard   | Kessler | **Partial:** example query only.                                                          | **Partial:** page and Leaflet map exist; activity controls and charts are planned. |
| Activity exploration | Kessler | **Planned:** filtered activity and time-series aggregations.                              | **Planned:** hourly/weekday charts, rankings and saved-filter controls.            |
| Allocation Planner   | Anna    | **Built:** scoring, fleet split, preview and PostgreSQL/MongoDB comparison.               | **Built:** settings, map, manual edits and store comparison.                       |
| Saved plans          | Anna    | **Built:** owner-filtered CRUD, immutable versions and version comparison.                | **Built:** create/open/rename/delete, save versions and compare versions.          |
| Saved views          | Caleb   | **Built:** owner-filtered create/list/get/rename/delete and validation.                   | **Planned:** save/open/rename/delete controls on Dashboard and Flow Explorer.      |

The supplied specification's "Operations Dashboard" and "Activity Explorer"
describe intended activity capabilities. They are not two additional implemented
navigation pages. The current tab is **Activity Dashboard**.

### 3.2 Extended scope

| Feature         | Owner | Implemented                                                                                        | Outstanding                                               |
| --------------- | ----- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Flow Explorer   | Caleb | Zone/month/day-type/time filters, top-10 destinations, map lines and month comparison.             | Saved-view controls and real authentication integration.  |
| Administration  | Sean  | Import overview, reason breakdowns, rejected-row pagination, reconciliation and benchmark display. | Final benchmark measurements and report interpretation.   |
| Benchmark suite | Sean  | Five questions, equivalent-answer checks, timings, sizes and query plans.                          | Run on the final evaluation machine and document results. |

### 3.3 Optional ideas

| Idea                            | Intended purpose                                    | Current boundary                                               |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Zone comparison                 | Compare two or three zones across activity metrics. | Optional; unassigned.                                          |
| Independent scenario comparison | Compare two separately saved allocation plans.      | Optional; existing comparison is between versions of one plan. |

### 3.4 Intended feature experience

The following retains the original UI and behavioral scope independently of
whether the corresponding feature is built.

| Core feature             | Intended experience                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Login and roles          | Authentication page, JWT token management, and distinct analyst/admin permissions.                                          |
| Operations Dashboard     | Landing view with a zone map colored by pickups or drop-offs, top zones, net-outflow imbalances and average metrics.        |
| Activity Explorer        | Filtered zone map, hourly moving-average charts, weekday breakdown, ranked zone table and a Save View button.               |
| Allocation Planner       | Fleet size, day, hour, borough and weight controls; zone scoring, largest-remainder allocation and manual taxi adjustments. |
| Saved plans (SQL CRUD)   | Create, open, rename, compare versions and save immutable versions; deleting the parent removes its history.                |
| Saved views (NoSQL CRUD) | Save, list, open, rename and delete custom filter setups, isolated by owner.                                                |

| Extended or optional feature   | Intended experience                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Flow Explorer (extended)       | Origin, month, day-type and time-bucket filters; top-ten destinations with trip share, fare and distance metrics.  |
| Administration (extended)      | Import history, accepted/warned/rejected counts, rejection reasons, reconciliation status and database benchmarks. |
| Zone comparison (optional)     | Side-by-side metrics for two or three taxi zones.                                                                  |
| Scenario comparison (optional) | Side-by-side comparison of two independent saved plans, beyond comparing versions of one plan.                     |

Operations Dashboard and Activity Explorer are retained as design concepts within
the activity scope. How they are arranged within the Activity Dashboard tab
remains a presentation decision, not a reason to drop either capability.

Sources: [dashboard](web/src/pages/Dashboard.tsx),
[planner](web/src/pages/Planner.tsx), [flows](web/src/pages/Flows.tsx),
[administration](web/src/pages/Admin.tsx) and
[saved-view routes](api/routers/saved_views.py).

---

## 4. Dataset and ingestion pipeline

### 4.1 Source files

Trip data comes from the official NYC TLC yellow taxi files for Q1 2026.
Downloads are checksum-pinned. Prefixes below identify the expected trip files;
the downloader contains their full SHA-256 hashes.

| Trip file                         | Raw rows  | SHA-256 prefix     |
| --------------------------------- | --------: | ------------------ |
| `yellow_tripdata_2026-01.parquet` | 3,724,889 | `8b3933fe6f0d7b6d` |
| `yellow_tripdata_2026-02.parquet` | 3,399,866 | `5352ca800f29c40a` |
| `yellow_tripdata_2026-03.parquet` | 3,952,451 | `d7af794a7ac06cbb` |

| Zone file              | Contents             | Loading behavior                                |
| ---------------------- | -------------------- | ----------------------------------------------- |
| `taxi_zone_lookup.csv` | 265 zone lookup rows | Zones 264 and 265 have no map shape.            |
| `taxi_zones.zip`       | Shapes for 263 zones | Convert EPSG:2263 to EPSG:4326 through PostGIS. |

#### Original file-size estimates

| Trip month | Size stated in the original plan |
| ---------- | -------------------------------: |
| January    | 61.2 MB                          |
| February   | Approximately 55 MB              |
| March      | Approximately 63 MB              |

These original estimates are retained for planning context. Their units and
exact byte counts have not been reverified; use the checksum to identify each
file. Download size is distinct from database, index and Docker storage.

Sources: [downloader](scripts/download_data.py) and [zone loader](etl/load_zones.py).

### 4.2 Classification flow

```text
Download and verify checksum
            |
            v
Check file/month import identity (R5)
            |
            v
COPY raw values into unlogged trip_staging
            |
            v
Classify: R1 -> R2 -> R3 -> R6 -> R4 -> R8 -> R9 -> R7
            |
            +-------------------------+
            |                         |
            v                         v
     rejected_trip                   trip
   raw fields + reason        accepted monthly partition
                                      |
                                      v
                          attach warnings in trip_warning
                                      |
                                      v
                         build summaries -> MongoDB -> reconcile
```

R5 is a file-level guard, not another row-classification stage. Reversal matching
is one-to-one: the negative correction is rejected and its positive twin is kept.

### 4.3 Rejection rules

The first applicable row rule wins.

| Priority   | Rule | Reject when                                                                                                          |
| ---------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| 1          | R1   | Pickup or drop-off timestamp is missing.                                                                             |
| 2          | R2   | Drop-off is **before** pickup: `dropoff_ts < pickup_ts`.                                                             |
| 3          | R3   | Pickup is outside the source file's month.                                                                           |
| 4          | R6   | Duration exceeds 24 hours.                                                                                           |
| 5          | R4   | Pickup zone is missing or has no map shape.                                                                          |
| 6          | R8   | Vendor, payment type or rate code violates lookup rules. Rate code 99 or a missing rate code is accepted as unknown. |
| 7          | R9   | Passenger count is negative, or a numeric value is non-finite or outside its destination column's range.             |
| 8          | R7   | A negative fare has a matching positive twin under the reversal rules.                                               |
| File guard | R5   | The file checksum or target month has already been imported.                                                         |

Equal pickup and drop-off timestamps are **not** rejected by R2; they can be
accepted with warning W9.

#### Original rule rationale

| Rule | Why the rule exists                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------ |
| R1   | Missing timestamps prevent reliable placement in time.                                                 |
| R2   | Inverted timestamps produce an invalid negative-duration trip.                                         |
| R3   | The pickup belongs to another month's dataset.                                                         |
| R6   | A duration over 24 hours may indicate a meter left running or a corrupted record.                      |
| R4   | An unmappable pickup cannot contribute to the intended zone-map statistics.                            |
| R8   | Unknown lookup values would violate foreign-key constraints.                                           |
| R9   | Non-finite, out-of-range or invalid passenger values cannot safely enter the constrained trip table.   |
| R7   | Reject the negative correction in a reversal pair rather than double-counting it as ordinary activity. |
| R5   | Refuse repeat file/month ingestion rather than duplicate an import.                                    |

### 4.4 Warning rules

Warnings do not reject the trip. They exclude affected values from the relevant
summaries; W7 excludes the entire trip from every summary.

| Rule | Flag when                                             | Exclude from                   |
| ---- | ----------------------------------------------------- | ------------------------------ |
| W1   | Distance is zero or negative.                         | Distance averages              |
| W2   | Fare is zero or negative.                             | Fare statistics                |
| W3   | Distance exceeds 100 miles.                           | Distance averages              |
| W4   | Fare exceeds $500.                                    | Fare statistics                |
| W5   | Duration exceeds 6 hours.                             | Duration averages              |
| W6   | Drop-off zone is missing or has no map shape.         | Drop-off counts and flows      |
| W7   | Payment type is 6: voided trip.                       | All summaries                  |
| W8   | Implied speed exceeds 80 mph for a positive duration. | Distance and duration averages |
| W9   | Drop-off timestamp equals pickup timestamp.           | Duration averages              |

Fare statistics additionally require metered trips (`payment_type_id <> 0`) with
a positive fare. Aggregate averages use sums divided by eligible counts, not
averages of hourly averages.

Sources: [import rules](etl/import_month.py), [summary definitions](sql/005_summaries.sql)
and [W9 migration](sql/008_w9_dropoff_not_recorded.sql).

### 4.5 Baseline counts

#### Import outcomes

| Month        | Rows read      | Accepted       | Rejected   | Acceptance rate |
| ------------ | -------------: | -------------: | ---------: | --------------: |
| January      | 3,724,889      | 3,683,870      | 41,019     | 98.90%          |
| February     | 3,399,866      | 3,371,085      | 28,781     | 99.15%          |
| March        | 3,952,451      | 3,927,859      | 24,592     | 99.38%          |
| **Q1 total** | **11,077,206** | **10,982,814** | **94,392** | **99.15%**      |

#### Quality flags and derived documents

| Month        | Reversals rejected (R7) | Accepted trips with warnings | Hourly documents | Flow snapshots |
| ------------ | ----------------------: | ---------------------------: | ---------------: | -------------: |
| January      | 35,048                  | 191,613                      | 195,672          | 2,478          |
| February     | 23,705                  | 182,215                      | 176,736          | 2,483          |
| March        | 18,294                  | 188,862                      | 195,409          | 2,491          |
| **Q1 total** | **77,047**              | **562,690**                  | **567,817**      | **7,452**      |

- R7 rows are a subset of rejected rows, not an additional rejection total.
- A warned trip can have several warning codes; warned-trip counts are not counts
  of warning records.
- Hourly grids cover 263 shaped zones: January has 744 hours, February 672 and
  March 743. The March total accounts for New York's daylight-saving transition.
- Drop-offs are counted at their drop-off time; late trips can contribute to the
  next month's drop-off counts.

Source: [README baseline results](README.md#results-january-to-march-2026).

---

## 5. PostgreSQL schema and integrity

### 5.1 Relationship overview

This is a simplified relationship guide, not the full submission ERD.
`1 --< N` means one-to-many.

```text
app_user  1 --< app_user_role >-- 1 app_role
    |
    +--< allocation_plan
              |
              +--< allocation_plan_version
                          |
                          +--< allocation_plan_version_borough >-- borough
                          |
                          +--< allocation_result >-- taxi_zone

import_batch 1 --< trip 1 --< trip_warning >-- validation_code
       |
       +--< rejected_trip >-- validation_code

taxi_zone supplies pickup/drop-off references for trip
taxi_zone 1 --< zone_hour_observation

Cross-database logical association, NOT a PostgreSQL foreign key:
app_user.user_id <--> MongoDB saved_analysis_views.ownerUserId
```

### 5.2 Identity and reference tables

| Table           | Primary key          | Important relationship or constraint                     |
| --------------- | -------------------- | -------------------------------------------------------- |
| `app_user`      | `user_id`            | Unique case-insensitive `lower(email)` index.            |
| `app_role`      | `role_id`            | Unique role name: analyst or admin.                      |
| `app_user_role` | `(user_id, role_id)` | Many-to-many user/role junction.                         |
| `borough`       | `borough_id`         | Referenced by zones and plan-version boroughs.           |
| `taxi_zone`     | `location_id`        | Zone attributes and PostGIS geometry with GiST indexing. |

### 5.3 Trip and summary tables

| Table                   | Primary key                                             | Purpose                                                      |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| `import_batch`          | `import_batch_id`                                       | File identity, month, counts and completion state.           |
| `trip`                  | `(import_batch_id, source_row_number, pickup_ts)`       | Accepted trips, range-partitioned by pickup month.           |
| `rejected_trip`         | `rejected_id`                                           | Raw rejected fields and reason; unique source row per batch. |
| `trip_warning`          | `(import_batch_id, source_row_number, pickup_ts, code)` | Warning junction with cascading trip reference.              |
| `zone_hour_observation` | `(location_id, obs_hour)`                               | Rebuildable hourly zone statistics.                          |

Trip indexes include BRIN on `pickup_ts` and B-tree zone/time indexes.
`od_summary` and `zone_weekday_hour_fare` are materialized views supporting
flows and median fares. Administrative records include `reconciliation_run`
and `benchmark_run`.

### 5.4 Allocation tables

For compactness, **plan-version key** means
`(allocation_plan_id, version_no)` in this table only.

| Table                             | Primary key                               | Purpose                                                       |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `allocation_plan`                 | `allocation_plan_id`                      | Named parent owned by a user; unique `(owner_user_id, name)`. |
| `allocation_plan_version`         | Plan-version key                          | Immutable settings snapshot.                                  |
| `allocation_plan_version_borough` | Plan-version key + `borough_id`           | Borough membership for that version.                          |
| `allocation_result`               | Plan-version key + `hour` + `location_id` | Proposed/final taxis, score, rank and explanation.            |

### 5.5 Database-enforced integrity

- **Import accounting:** `rows_accepted + rows_rejected = rows_read`.
- **Immutable history:** saved versions, version boroughs and results cannot be
  updated or individually deleted. Deleting the parent plan cascades through
  its history.
- **Fleet totals:** each hour's final allocations must sum to the fleet size.
- **Complete hours:** a version must contain every configured hour and no
  out-of-range result hour.
- **Valid zones:** each result must use a shaped zone in the version's boroughs.

Sources: [users](sql/003_users.sql), [trips](sql/004_trips.sql),
[summaries](sql/005_summaries.sql), [plans](sql/006_plans.sql),
[complete hours](sql/011_plan_hours_complete.sql) and
[immutable history and zones](sql/012_plan_integrity.sql).

Database storage is environment-dependent. The supplied document's fixed
"2.8 GB for Q1" claim is retained as an **original reported estimate**, not a
verified or portable storage requirement.

---

## 6. MongoDB collections and document design

### 6.1 Application collections

| Collection                     | Storage model       | Document granularity                                                 |
| ------------------------------ | ------------------- | -------------------------------------------------------------------- |
| `zone_activity_timeseries`     | Time-series         | One shaped zone per hour; 567,817 documents for Q1.                  |
| `origin_destination_snapshots` | Standard collection | One origin/month/day-type/time-bucket slice; 7,452 documents for Q1. |
| `saved_analysis_views`         | Standard collection | One user's named filter state.                                       |

### 6.2 Indexes and validation

- **Hourly activity:** `timeField: "timestamp"`, `metaField: "meta"`,
  `granularity: "hours"`. Query indexes include `{meta.zoneId, timestamp}`,
  `{localDate, localHour}` and `{isoDayOfWeek, localHour}`.
- **Destination snapshots:** unique index on
  `{originZoneId, month, dayType, timeBucket}`; each slice embeds at most ten
  destinations.
- **Saved views:** unique `{ownerUserId, name}` index and a JSON Schema validator.
  The API also checks zone and borough references against PostgreSQL.
- **Time-series validation limitation:** MongoDB 8.0 does not accept a collection
  validator on a time-series collection. The loader checks hourly documents
  itself; do not claim database-level JSON Schema enforcement there.
- **Application credentials:** the API uses a MongoDB account with `readWrite`
  on the application database, rather than the loader's root account.

Source: [MongoDB loader, schemas and indexes](etl/load_mongo.py).

### 6.3 Illustrative document shapes

These values explain structure; they are **not measured query results**.
MongoDB stores `timestamp` as a BSON date, represented here as an ISO string.

#### Hourly activity

```json
{
  "timestamp": "2026-01-05T13:00:00Z",
  "meta": { "zoneId": 236, "borough": "Manhattan" },
  "localDate": "2026-01-05",
  "localHour": 8,
  "isoDayOfWeek": 1,
  "pickups": 369,
  "dropoffs": 245,
  "imbalance": 124,
  "fareSum": 3773.50,
  "fareTripCount": 322,
  "averageFare": 11.7189,
  "distanceSum": 714.25,
  "distanceTripCount": 364,
  "averageDistance": 1.9622,
  "durationSumSec": 232074,
  "durationTripCount": 365,
  "averageDurationSec": 635.8192
}
```

#### Destination snapshot

The original examples are retained here as supplied illustrations, not verified
records or arithmetic fixtures. The destination list below shows only one entry
of a longer list; real slices can embed up to ten. Shares are relative to all
trips in the slice.

```json
{
  "originZoneId": 161,
  "originBorough": "Manhattan",
  "month": "2026-01",
  "dayType": "weekday",
  "timeBucket": "am_peak",
  "totalTrips": 12450,
  "destinationCount": 185,
  "destinations": [
    {
      "rank": 1,
      "zoneId": 236,
      "zoneName": "Upper East Side North",
      "borough": "Manhattan",
      "trips": 1420,
      "share": 0.1141,
      "averageFare": 14.20,
      "averageDistance": 2.35,
      "averageDurationSec": 780
    }
  ]
}
```

Flow comparisons use each month's stored top ten, not the complete
origin-destination matrix. "Not in top ten" does not necessarily mean zero trips.
See [flow query semantics](api/flows.py).

---

## 7. Fleet allocation model

### 7.1 API input parameters

| Parameter                | Meaning                                    | Constraint or default              |
| ------------------------ | ------------------------------------------ | ---------------------------------- |
| `fleet_size`             | Taxis allocated in each hour               | Integer, 1 to 100,000              |
| `iso_dow`                | Weekday                                    | 1 = Monday through 7 = Sunday      |
| `start_hour`, `end_hour` | Inclusive local hour range                 | 0 to 23; start must not exceed end |
| `borough_ids`            | Allowed borough identifiers                | Non-empty list                     |
| `max_zones_per_hour`     | Maximum selected zones per hour            | Default 10; 1 to 263               |
| `min_sample`             | Minimum historical pickups for eligibility | Default 30; non-negative           |
| `note`                   | Optional version note                      | Up to 500 characters               |

| Weight parameter | Metric           | Default  |
| ---------------- | ---------------- | -------: |
| `w_pickup`       | Pickup activity  | 0.50     |
| `w_imbalance`    | Net outflow      | 0.25     |
| `w_consistency`  | Consistency      | 0.15     |
| `w_fare`         | Median fare      | 0.10     |
| **Total**        | **Must equal 1** | **1.00** |

### 7.2 Scoring and fleet split

For each eligible zone `z` in hour `h`, across the loaded historical days:

1. **Pickup activity:** mean pickups.
2. **Net outflow:** mean pickups minus drop-offs; negative values are not clipped.
3. **Consistency:** `1 / (1 + CV)`, using population standard deviation divided
   by mean pickups.
4. **Median fare:** precomputed `percentile_cont(0.5)` over eligible metered trips.
   A missing median counts as zero for ranking and is explained as unknown.
5. **Percentile ranking:** apply `cume_dist` to each metric within the hour's
   candidate set. This is not min-max scaling.
6. **Weighted score:**

   ```text
   S(z) = w_pickup      * percentile(pickup activity)
        + w_imbalance   * percentile(net outflow)
        + w_consistency * percentile(consistency)
        + w_fare        * percentile(median fare)
   ```

7. **Select zones:** keep the best-ranked eligible zones up to the configured limit.
8. **Split the fleet among selected zones:**

   ```text
   exact(z)     = fleet_size * S(z) / sum(selected scores)
   base(z)      = floor(exact(z))
   remainder(z) = exact(z) - base(z)
   leftovers    = fleet_size - sum(base allocations)
   ```

   Assign leftover taxis by descending remainder, then descending score and
   ascending zone ID to break ties deterministically.

9. **Review and save:** the analyst can adjust final taxis. Every saved hour must
   still total the fleet size. An hour with no eligible zones is reported as empty,
   not presented as a successful balanced allocation.

Creating a named plan does **not** create version 1. Saving the allocation is a
separate version-creation request.

Sources: [planner logic](api/planner.py), [request models and routes](api/routers/plans.py)
and [median-fare view](sql/010_zone_weekday_hour_fare.sql).

### 7.3 Original specification notation

The original mathematical model remains part of the plan. For zone `z` in
hour `h`:

```text
A_z    = mean historical pickups
O_z    = mean historical (pickups - drop-offs), unclipped
CV_z   = population standard deviation of pickups / mean pickups
C_z    = 1 / (1 + CV_z)
F_z    = median eligible metered fare
P(M_z) = cume_dist(M_z), for M in {A, O, C, F}

S_z = w_1 * P(A_z) + w_2 * P(O_z) + w_3 * P(C_z) + w_4 * P(F_z)

E_z = fleet_size * S_z / sum(selected S_k)
I_z = floor(E_z)
R_z = E_z - I_z
L   = fleet_size - sum(I_z)
```

Distribute the `L` remaining taxis one each to the largest remainders, with
deterministic tie-breaking. Defaults are `w_1 = 0.50`, `w_2 = 0.25`,
`w_3 = 0.15`, `w_4 = 0.10`; their sum must equal 1.

| Original conceptual input  | Current API representation                           |
| -------------------------- | ---------------------------------------------------- |
| `weekday`                  | `iso_dow`                                            |
| `hour_from`, `hour_to`     | `start_hour`, `end_hour`                             |
| `boroughs` (names)         | `borough_ids` (identifiers)                          |
| `min_sample_size`          | `min_sample`                                         |
| `weights` (`w_1` to `w_4`) | `w_pickup`, `w_imbalance`, `w_consistency`, `w_fare` |

Both vocabularies are retained: the first explains the original design; the
second prevents mistaking conceptual names for fields accepted by today's API.

---

## 8. API reference: implemented versus proposed

Paths below are **backend paths** on port 8000. Through the website's proxy on
port 8080, prepend `/api`: backend `/health` becomes website `/api/health`.
FastAPI's own routes do not all carry an `/api` prefix.

**Access terminology**

- **Public:** no `current_user` dependency in the current route.
- **Dev user:** route uses the current development-user dependency; replace it
  with real authentication later.
- **Owner:** operations are filtered by the development user's ID today.
- **Admin:** admin-role check exists, with the development-identity caveat.

### 8.1 Health, geography and dashboard placeholder

| Method | Backend path         | Current access | Purpose                                           |
| ------ | -------------------- | -------------- | ------------------------------------------------- |
| GET    | `/health`            | Public         | Both database connections and loaded months.      |
| GET    | `/boroughs`          | Public         | Boroughs with shaped zones.                       |
| GET    | `/zones`             | Public         | Shaped-zone attributes.                           |
| GET    | `/zones/geojson`     | Public         | Simplified polygons for Leaflet.                  |
| GET    | `/zones/centroids`   | Public         | Interior zone points for flow lines.              |
| GET    | `/dashboard/example` | Public         | Placeholder hourly-row count, not dashboard KPIs. |

### 8.2 Flow Explorer

| Method | Backend path            | Current access | Purpose                                   |
| ------ | ----------------------- | -------------- | ----------------------------------------- |
| GET    | `/flows`                | Dev user       | Top destinations for one validated slice. |
| GET    | `/flows/months`         | Dev user       | Months with destination snapshots.        |
| GET    | `/flows/compare-months` | Dev user       | Compare the slice across loaded months.   |

These routes read MongoDB snapshots. Geography routes read PostgreSQL/PostGIS.

### 8.3 Allocation plans

| Method         | Backend path                             | Purpose                                                   |
| -------------- | ---------------------------------------- | --------------------------------------------------------- |
| POST           | `/plans/preview`                         | Compute an unsaved proposal.                              |
| POST           | `/plans/compare-stores`                  | Compare statistics and timings in both stores.            |
| GET / POST     | `/plans`                                 | List owned plans / create a named plan without a version. |
| PATCH / DELETE | `/plans/{plan_id}`                       | Rename / delete an owned plan and its history.            |
| GET / POST     | `/plans/{plan_id}/versions`              | List / save immutable versions.                           |
| GET            | `/plans/{plan_id}/versions/{version_no}` | Open one saved version.                                   |
| GET            | `/plans/{plan_id}/compare`               | Compare two versions of the same plan.                    |

Plan routes use the development-user dependency; stored-plan operations enforce
ownership. PostgreSQL stores the plans.

### 8.4 Saved views

| Method     | Backend path       | Purpose                                             |
| ---------- | ------------------ | --------------------------------------------------- |
| GET / POST | `/views`           | List / create the caller's views.                   |
| GET        | `/views/{view_id}` | Open an owned view.                                 |
| PATCH      | `/views/{view_id}` | Rename an owned view; not arbitrary filter editing. |
| DELETE     | `/views/{view_id}` | Delete an owned view.                               |

Views live in MongoDB. Creation validates zone/borough references in PostgreSQL.
All operations use the development-user identity and filter by owner.

### 8.5 Administration

| Method | Backend path            | Purpose                                                  |
| ------ | ----------------------- | -------------------------------------------------------- |
| GET    | `/admin/imports`        | Import counts, reject reasons and warning reasons.       |
| GET    | `/admin/rejected`       | Rejected rows, 50 per page, with optional reason filter. |
| GET    | `/admin/reconciliation` | Read reconciliation history.                             |
| GET    | `/admin/benchmarks`     | Read the latest benchmark results.                       |

These routes require the admin role and read PostgreSQL records. There is **no
POST reconciliation/rebuild route**; reconciliation and benchmark execution are
scripts, not actions supplied by these GET endpoints.

### 8.6 Planned API from the original specification

These original API requirements remain in the master plan. They describe the
intended interface, not a claim that today's server implements them. Paths below
use the original website-facing `/api` prefix.

| Method | Planned website path        | Intended access | Target store         |
| ------ | --------------------------- | --------------- | -------------------- |
| POST   | `/api/auth/login`           | Public          | PostgreSQL           |
| GET    | `/api/auth/me`              | Authenticated   | PostgreSQL           |
| GET    | `/api/dashboard`            | Authenticated   | MongoDB / PostgreSQL |
| GET    | `/api/activity/zones`       | Authenticated   | MongoDB              |
| GET    | `/api/activity/hourly`      | Authenticated   | MongoDB              |
| GET    | `/api/activity/weekday`     | Authenticated   | MongoDB              |
| POST   | `/api/admin/reconciliation` | Admin           | Both databases       |

| Planned endpoint            | Original intended behavior                                                         |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Login                       | Verify an Argon2 password hash and issue a JWT.                                    |
| Current profile             | Return the authenticated session user's profile.                                   |
| Dashboard                   | Return KPI metrics and top zones.                                                  |
| Zone activity               | Return activity metrics with filter parameters.                                    |
| Hourly activity             | Return an hourly series with moving averages.                                      |
| Weekday activity            | Return weekday distributions.                                                      |
| Admin reconciliation action | Trigger a month rebuild/reconciliation workflow; GET continues to provide history. |

The final request bodies, permissions and rebuild semantics still need agreement.
Retaining the original POST proposal does not add a working rebuild endpoint.

### 8.7 Original target behavior versus current behavior

- **Authentication:** the original plan protects boroughs, zones and activity
  routes with authenticated access. Current geography and example routes remain
  public; that implementation difference does not remove the target requirement.
- **Plan creation:** the original `/api/plans` description combines creation with
  version 1. The current API creates the named parent first and saves a version
  separately. Preserve the original desired creation experience as a design
  requirement to clarify, rather than claiming it is already implemented.
- **Saved-view updates:** the original `/api/views/{id}` description says
  "update or delete saved view configuration." Current PATCH only renames.
  Broader configuration editing remains an original design intent whose exact
  scope needs confirmation.
- **Admin execution:** the original design includes benchmark suites and a
  reconciliation/rebuild action. The current page displays results; scripts
  perform execution. UI-triggered execution is not currently implemented.

Sources: [route registration](api/main.py), [health](api/routers/health.py),
[geography](api/routers/zones.py), [dashboard](api/routers/dashboard.py),
[flows](api/routers/flows.py), [plans](api/routers/plans.py),
[views](api/routers/saved_views.py) and [administration](api/routers/admin.py).

---

## 9. Performance comparison and evidence

### 9.1 Implemented benchmark design

The benchmark copies hourly summaries into three stores with equivalent indexes:

| Store                          | Benchmark data source        |
| ------------------------------ | ---------------------------- |
| PostgreSQL                     | `bench_zone_hour`            |
| MongoDB standard collection    | `bench_zone_hour_collection` |
| MongoDB time-series collection | `bench_zone_hour_timeseries` |

| Question | Query scope                                   | Compared stores                                                       |
| -------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Q1       | One zone for one hour                         | All three hourly stores                                               |
| Q2       | One zone over seven days                      | All three hourly stores                                               |
| Q3       | Monthly totals for every zone                 | All three hourly stores                                               |
| Q4       | Monthly top ten zones                         | All three hourly stores                                               |
| Q5       | Top ten destinations for one origin and slice | PostgreSQL `od_summary` versus MongoDB `origin_destination_snapshots` |

The script records an initial run, then 50 timed runs per query by default,
including median and 95th-percentile latency. It also records data/index sizes,
load times where applicable and query plans. Results are saved to `benchmark_run`
only after the equivalent-answer checks pass.

The first timing is called "cold" in the implementation; that label does not
establish that operating-system or database caches were flushed.

### 9.2 Historical numbers supplied with this document

**Unverified historical figures, not final benchmark results.** The supplied
document does not identify a machine, run record or reproducible output for these
numbers. They are retained for traceability, not as evidence of current performance.

| Planner statistics scope      | Reported rows | Reported PostgreSQL latency |
| ----------------------------- | ------------: | --------------------------- |
| Manhattan, Monday 07:00-09:00 | 1,035         | 8-17 ms                     |
| All boroughs, Monday full day | 31,560        | 57-101 ms                   |

| Same scope                    | Reported MongoDB without index | Reported MongoDB with index |
| ----------------------------- | -----------------------------: | --------------------------: |
| Manhattan, Monday 07:00-09:00 | 200 ms                         | 96 ms                       |
| All boroughs, Monday full day | 910 ms                         | 435 ms                      |

| Historical storage claim           | Data only | Including indexes |
| ---------------------------------- | --------: | ----------------: |
| MongoDB time-series hourly records | 29.5 MB   | 45 MB             |
| PostgreSQL hourly table            | 57 MB     | 89 MB             |

The supplied document also reports approximately 35.2 MB for MongoDB application
documents without defining the measurement. It must not be compared directly
with the hourly-only storage figures above.

Do not infer universal PostgreSQL speed superiority, MongoDB compression savings
or a specific cause of latency from these unverified figures. Final conclusions
must identify the machine, dataset, indexes, repetitions, query plans and measured
results, and distinguish hourly aggregation from embedded destination reads.

### 9.3 Current evidence boundary

- The benchmark script and Administration display are implemented.
- No production-data benchmark run was present in the local application database
  during environment verification on 19 October 2026.
- Tests against small sample data validate behavior; they are not final
  performance measurements.
- `--explain-summary` supports an `EXPLAIN ANALYZE` of a summary build inside a
  rolled-back transaction.

Sources: [benchmark implementation](etl/benchmark.py),
[benchmark tests](tests/test_benchmark.py) and
[benchmark usage](README.md#run-the-benchmark).

### 9.4 Original benchmark interpretation retained for evaluation

The original document attributes PostgreSQL's reported speed advantage to
B-tree indexes on structured numeric columns and MongoDB's reported slower
aggregation to time-series bucket decompression. It also presents MongoDB
time-series compression as a storage-efficiency advantage.

These explanations remain **hypotheses and original reported conclusions to
evaluate**, not established causes or universal database properties. Keep the
original comparison goal: test latency and storage trade-offs with equivalent
answers and query plans, including the embedded-destination use case.

---

## 10. Open decisions and outstanding deliverables

This section records scope and unresolved deliverables, **not an implementation
sequence or schedule**.

### 10.1 Already agreed and implemented

The navigation has four tabs: **Activity Dashboard**, **Flow Explorer**,
**Allocation Planner** and **Administration**. Naming alignment is not an open
implementation task. See [application navigation](web/src/App.tsx).

### 10.2 Remaining functional scope

| Area               | Remaining deliverable                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Activity Dashboard | Real activity queries, filters, rankings, imbalances, hourly charts and comparisons.              |
| Saved views        | Website controls and restoration of saved filter state.                                           |
| Authentication     | Real password verification, JWT sessions and login UI.                                            |
| Authorization      | Integrate actual authenticated identities with analyst/admin access rules.                        |
| User deletion      | Remove MongoDB saved views before PostgreSQL account deletion; SQL cascades cannot reach MongoDB. |
| Benchmarks         | Final-machine measurements and a supported interpretation of SQL/NoSQL trade-offs.                |

### 10.3 Decisions and report requirements

- **Database roles:** dedicated PostgreSQL read/write roles are a proposed
  security design, not installed by an existing migration. The original target
  names are `ycq_read` (SELECT only) and `ycq_write` (write-capable API role).
  The original instruction to execute `sql/013` cannot implement those roles:
  `013` already defines
  R8/R9 rejection codes. Any new role migration needs the next unused number
  (currently `014`); administrative writes must remain possible.
- **Cross-database ownership:** saved-view ownership is enforced by application
  queries, not a database-level cross-store foreign key.
- **Final ERD:** use the real schema, including user-role and version-borough
  junctions, composite trip/version keys, warnings and administrative tables.
- **Report accuracy:** use the verified dataset counts, describe percentile
  scoring rather than min-max scaling, and justify MongoDB against relevant
  NoSQL alternatives without unsupported performance claims.
- **Submission materials:** complete the report, slides and video; the existing
  project status says the submission must include `data/`. Confirm the final
  packaging against the module brief.
- **Documentation consistency:** README and STATUS contain stale feature-status
  statements; current source code takes precedence for implemented behavior.

For intended future scope, this master plan remains the reference. The current
code is evidence of implementation progress, not a basis for deleting planned
features. Optional comparisons remain optional rather than silently becoming
mandatory work.

Sources: [R8/R9 migration](sql/013_r8_r9_rejects.sql),
[project status](STATUS.md) and [working conventions](README.md#working-on-the-project).

---

_End of the master technical specification. Unfinished capabilities above are
scope statements, not claims that those features already work._
