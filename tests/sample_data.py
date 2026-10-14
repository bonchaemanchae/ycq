"""Small hand-made TLC files for the tests.

Each row is one case, and its position in the file is its source_row_number,
so the tests can check exactly what happened to row N. Columns and types match
the real 2026 TLC files.

Zones used: 1, 2 and 3 have a map shape; 264 and 265 don't.
"""
from datetime import datetime, timedelta

import polars as pl

SCHEMA = {
    "VendorID": pl.Int32,
    "tpep_pickup_datetime": pl.Datetime("us"),
    "tpep_dropoff_datetime": pl.Datetime("us"),
    "passenger_count": pl.Int64,
    "trip_distance": pl.Float64,
    "RatecodeID": pl.Int64,
    "store_and_fwd_flag": pl.String,
    "PULocationID": pl.Int32,
    "DOLocationID": pl.Int32,
    "payment_type": pl.Int64,
    "fare_amount": pl.Float64,
    "extra": pl.Float64,
    "mta_tax": pl.Float64,
    "tip_amount": pl.Float64,
    "tolls_amount": pl.Float64,
    "improvement_surcharge": pl.Float64,
    "total_amount": pl.Float64,
    "congestion_surcharge": pl.Float64,
    "Airport_fee": pl.Float64,
    "cbd_congestion_fee": pl.Float64,
}


def trip(pickup, minutes=15, pu=1, do=2, dist=2.0, fare=12.0, vendor=2,
         payment=1, rate=1, dropoff="auto"):
    """One trip. minutes=None gives no drop-off time."""
    start = datetime.fromisoformat(pickup) if pickup else None
    if dropoff == "auto":
        end = start + timedelta(minutes=minutes) if start and minutes is not None else None
    else:
        end = datetime.fromisoformat(dropoff) if dropoff else None
    return {
        "VendorID": vendor,
        "tpep_pickup_datetime": start,
        "tpep_dropoff_datetime": end,
        "passenger_count": 1,
        "trip_distance": dist,
        "RatecodeID": rate,
        "store_and_fwd_flag": "N",
        "PULocationID": pu,
        "DOLocationID": do,
        "payment_type": payment,
        "fare_amount": fare,
        "extra": 0.0,
        "mta_tax": 0.5,
        "tip_amount": 0.0,
        "tolls_amount": 0.0,
        "improvement_surcharge": 1.0,
        "total_amount": fare + 1.5,
        "congestion_surcharge": 0.0,
        "Airport_fee": 0.0,
        "cbd_congestion_fee": 0.0,
    }


# January: (row number) -> what should happen to it.
JANUARY = [
    # 1-3: normal trips. Zone 1, Monday 5 and 12 January, 8 AM.
    trip("2026-01-05 08:00", 20, dist=3.0, fare=15.0),                 # 1
    trip("2026-01-05 08:10", 10, dist=2.0, fare=10.0),                 # 2
    trip("2026-01-12 08:05", 30, do=3, dist=6.0, fare=31.0,
         vendor=1, payment=2),                                         # 3 cash
    # 4-10: rejected
    trip("2026-01-06 09:00", None),                                    # 4 R1 no drop-off
    trip("2026-01-06 09:00", -5),                                      # 5 R2 drop-off first
    trip("2026-02-01 00:30", 10),                                      # 6 R3 February pickup
    trip("2026-01-06 09:00", 25 * 60),                                 # 7 R6 25 hours
    trip("2026-01-06 09:00", 10, pu=264),                              # 8 R4 zone with no shape
    trip("2026-01-06 09:00", 10, pu=None),                             # 9 R4 no zone
    trip("2026-01-05 08:00", 20, dist=3.0, fare=-15.0),                # 10 R7 reversal of row 1
    # 11-21: accepted with one warning each
    trip("2026-01-05 08:30", 18, dist=0.0, fare=8.0, payment=0,
         rate=None),                                                   # 11 W1 (Flex Fare, no distance)
    trip("2026-01-07 10:00", 10, fare=0.0),                            # 12 W2 fare 0
    trip("2026-01-07 11:00", 10, fare=-5.0),                           # 13 W2 negative, no twin
    trip("2026-01-08 06:00", 240, dist=150.0, fare=400.0),             # 14 W3 150 miles
    trip("2026-01-05 08:40", 60, dist=30.0, fare=600.0),               # 15 W4 $600
    trip("2026-01-14 10:00", 420, dist=5.0, fare=20.0),                # 16 W5 7 hours
    trip("2026-01-09 12:00", 10, do=265),                              # 17 W6 drop-off zone with no shape
    trip("2026-01-09 13:00", 10, do=None),                             # 18 W6 no drop-off zone
    trip("2026-01-09 14:00", 10, payment=6),                           # 19 W7 voided
    trip("2026-01-10 15:00", 10, dist=50.0, fare=30.0),                # 20 W8 300 mph
    trip("2026-01-10 16:00", 0, vendor=7),                             # 21 W9 Helix, no drop-off time
    # 22-23: accepted, no warning
    trip("2026-01-11 17:00", 10, rate=99),                             # 22 rate code 99 -> NULL
    trip("2026-01-31 23:50", 20, pu=2, do=3),                          # 23 drop-off on 1 February
    # 24-26: two reversals but only one original
    trip("2026-01-20 10:00", 15, pu=3, do=1, fare=12.0, vendor=1),     # 24 kept
    trip("2026-01-20 10:00", 15, pu=3, do=1, fare=-12.0, vendor=1),    # 25 R7
    trip("2026-01-20 10:00", 15, pu=3, do=1, fare=-12.0, vendor=1),    # 26 W2 (no second original)
    # 27-28: a reversal pair whose pickup zone fails R4 first
    trip("2026-01-21 09:00", 10, pu=264, do=1, fare=9.0),              # 27 R4
    trip("2026-01-21 09:00", 10, pu=264, do=1, fare=-9.0),             # 28 R4, not R7
]

JANUARY_REJECTS = {4: "R1", 5: "R2", 6: "R3", 7: "R6", 8: "R4", 9: "R4",
                   10: "R7", 25: "R7", 27: "R4", 28: "R4"}
JANUARY_WARNINGS = {11: {"W1"}, 12: {"W2"}, 13: {"W2"}, 14: {"W3"}, 15: {"W4"},
                    16: {"W5"}, 17: {"W6"}, 18: {"W6"}, 19: {"W7"}, 20: {"W8"},
                    21: {"W9"}, 26: {"W2"}}

FEBRUARY = [trip("2026-02-02 09:00", 15)]

# 8 March 2026: clocks jump from 2:00 to 3:00 AM.
MARCH = [trip("2026-03-08 01:30", 20), trip("2026-03-08 03:10", 20)]


def write(rows, path):
    pl.DataFrame(rows, schema=SCHEMA).write_parquet(path)
    return path
