# Data: sources, import rules and results

## Sources

- **Trip records:** the official NYC Taxi and Limousine Commission (TLC)
  yellow taxi trip records for January, February and March 2026, one Parquet
  file per month. Each trip has its pickup and drop-off time and zone,
  distance, passengers, fare and its parts, and payment type.
- **Taxi zones:** TLC's 263 taxi zones with their map shapes (loaded into
  PostGIS), plus TLC's two codes for an unknown location (264) and outside New
  York (265), which have no shape.
- **Lookup codes:** vendors, rate codes and payment types, seeded in
  `sql/002_lookups.sql` with every value found in the TLC data.

Each file, including the zone lookup (`taxi_zone_lookup.csv`) and shapes
(`taxi_zones.zip`), is checked by SHA-256 against a value pinned in
`scripts/download_data.py`. The trip files' values start `8b3933fe6f0d7b6d`
(January), `5352ca800f29c40a` (February) and `d7af794a7ac06cbb` (March). A
file that differs is renamed to `.mismatch` and never imported.

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

Other rules:

- Fare statistics use metered trips only (not payment type 0, Flex Fare) with
  a fare above zero.
- Rate code 99 (unknown) is stored as NULL.
- Times stay in New York local time, and the hourly grid follows the real
  clock (8 March 2026 has 23 hours).
- Drop-offs are counted in the hour they happen, so a trip that ends after
  midnight on the last day of a month adds its drop-off to the next month.

## Results (January to March 2026)

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

In total: 11,077,206 rows read, 10,982,814 trips accepted, 94,392 rejected
(0.85%).

After all three months, `zone_weekday_hour_fare` (the planner's median fares)
has 34,521 rows built from 7,911,745 metered trips. No month has voided trips
(W7). In January, 35,171 negative-fare rows have a positive twin; 123 of them
already fail an earlier rule (121 R4, 1 R3, 1 R6), so 35,048 are recorded as R7
and every reversal is still rejected. 2,250 January trips add their drop-off
to 1 February.

## Known data notes

- 25–26 January and 22–23 February have very low volume because of two
  blizzards (real events, not missing data). Daily trends flags 25 January
  (−61%), 26 January (−35%) and 23 February (−76%) as unusual days, each
  against a normal day of the same weekday.
- About 9% of Flex Fare trips have no distance recorded.
