"""Import one month of TLC yellow taxi trips.

    python import_month.py --month 2026-01 [--file path/to.parquet]

Steps, all in one transaction:
  1. Refuse the file if it, or any file for the same month, was already
     imported (R5).
  2. COPY the raw rows into the loose trip_staging table.
  3. Sort every row in SQL: rejected rows (R1-R4, R6, R7) go to rejected_trip,
     the rest go to the month's trip partition.
  4. Record warnings (W1-W9) for accepted trips in trip_warning.
The month argument sets the partition and the R3 date range.
"""
import argparse
import hashlib
import io
import sys
import time
from pathlib import Path

import polars as pl

from common import DATA, next_month, parse_month, pg_connect

# parquet column -> staging column
COLUMNS = {
    "VendorID": "vendor_id",
    "tpep_pickup_datetime": "pickup_ts",
    "tpep_dropoff_datetime": "dropoff_ts",
    "passenger_count": "passenger_count",
    "trip_distance": "trip_distance",
    "RatecodeID": "rate_code_id",
    "store_and_fwd_flag": "store_and_fwd_flag",
    "PULocationID": "pickup_location_id",
    "DOLocationID": "dropoff_location_id",
    "payment_type": "payment_type_id",
    "fare_amount": "fare_amount",
    "extra": "extra",
    "mta_tax": "mta_tax",
    "tip_amount": "tip_amount",
    "tolls_amount": "tolls_amount",
    "improvement_surcharge": "improvement_surcharge",
    "total_amount": "total_amount",
    "congestion_surcharge": "congestion_surcharge",
    "Airport_fee": "airport_fee",
    "cbd_congestion_fee": "cbd_congestion_fee",
}
RAW_COLS = list(COLUMNS.values())
COPY_CHUNK = 250_000

# Reject rules, checked in this order; a row gets the first that applies.
# R7 (reversal) is decided last, only among rows that passed R1-R6.
CLASSIFY_SQL = """
CREATE TEMP TABLE staged ON COMMIT DROP AS
SELECT s.*,
       CASE
           WHEN s.pickup_ts IS NULL OR s.dropoff_ts IS NULL         THEN 'R1'
           WHEN s.dropoff_ts < s.pickup_ts                          THEN 'R2'
           WHEN s.pickup_ts < %(start)s OR s.pickup_ts >= %(end)s   THEN 'R3'
           WHEN s.dropoff_ts - s.pickup_ts > interval '24 hours'    THEN 'R6'
           WHEN NOT EXISTS (SELECT 1 FROM taxi_zone z
                            WHERE z.location_id = s.pickup_location_id
                              AND z.geom IS NOT NULL)               THEN 'R4'
       END::varchar(3) AS reason_code
FROM trip_staging s
WHERE s.import_batch_id = %(batch)s
"""

REVERSAL_SQL = """
-- R7: a negative-fare row whose positive twin (same vendor, pickup time,
-- pickup zone, drop-off zone, opposite fare) is in the same file. Negatives
-- and positives are paired one to one, so two reversals need two originals.
WITH candidates AS (
    SELECT source_row_number, fare_amount < 0 AS is_negative,
           row_number() OVER (
               PARTITION BY vendor_id, pickup_ts, pickup_location_id,
                            dropoff_location_id, abs(fare_amount), fare_amount < 0
               ORDER BY source_row_number) AS pair_no,
           vendor_id, pickup_ts, pickup_location_id, dropoff_location_id,
           abs(fare_amount) AS abs_fare
    FROM staged
    WHERE reason_code IS NULL AND fare_amount <> 0
), reversals AS (
    SELECT n.source_row_number
    FROM candidates n
    JOIN candidates p
      ON  p.vendor_id = n.vendor_id
      AND p.pickup_ts = n.pickup_ts
      AND p.pickup_location_id = n.pickup_location_id
      AND p.dropoff_location_id IS NOT DISTINCT FROM n.dropoff_location_id
      AND p.abs_fare = n.abs_fare
      AND p.pair_no = n.pair_no
      AND NOT p.is_negative
    WHERE n.is_negative
)
UPDATE staged s SET reason_code = 'R7'
FROM reversals r
WHERE s.source_row_number = r.source_row_number;
"""

INSERT_REJECTED_SQL = f"""
INSERT INTO rejected_trip (import_batch_id, source_row_number, reason_code, {", ".join(RAW_COLS)})
SELECT import_batch_id, source_row_number, reason_code, {", ".join(RAW_COLS)}
FROM staged
WHERE reason_code IS NOT NULL
"""

INSERT_TRIPS_SQL = """
INSERT INTO trip (
    import_batch_id, source_row_number, pickup_ts, dropoff_ts, vendor_id,
    passenger_count, trip_distance, rate_code_id, store_and_fwd_flag,
    pickup_location_id, dropoff_location_id, payment_type_id,
    fare_amount, extra, mta_tax, tip_amount, tolls_amount,
    improvement_surcharge, total_amount, congestion_surcharge, airport_fee,
    cbd_congestion_fee)
SELECT s.import_batch_id, s.source_row_number, s.pickup_ts, s.dropoff_ts, s.vendor_id,
       s.passenger_count, round(s.trip_distance::numeric, 2),
       NULLIF(s.rate_code_id, 99),                -- 99 = unknown -> NULL
       CASE s.store_and_fwd_flag WHEN 'Y' THEN true WHEN 'N' THEN false END,
       s.pickup_location_id,
       z.location_id,                             -- NULL when not a known zone
       s.payment_type_id,
       round(s.fare_amount::numeric, 2), round(s.extra::numeric, 2),
       round(s.mta_tax::numeric, 2), round(s.tip_amount::numeric, 2),
       round(s.tolls_amount::numeric, 2), round(s.improvement_surcharge::numeric, 2),
       round(s.total_amount::numeric, 2), round(s.congestion_surcharge::numeric, 2),
       round(s.airport_fee::numeric, 2), round(s.cbd_congestion_fee::numeric, 2)
FROM staged s
LEFT JOIN taxi_zone z ON z.location_id = s.dropoff_location_id
WHERE s.reason_code IS NULL
"""

# One row per warning per accepted trip.
INSERT_WARNINGS_SQL = """
INSERT INTO trip_warning (import_batch_id, source_row_number, pickup_ts, code)
SELECT t.import_batch_id, t.source_row_number, t.pickup_ts, w.code
FROM trip t
LEFT JOIN taxi_zone dz ON dz.location_id = t.dropoff_location_id
CROSS JOIN LATERAL (
    SELECT extract(epoch FROM t.dropoff_ts - t.pickup_ts) AS secs
) d
CROSS JOIN LATERAL (VALUES
    ('W1', t.trip_distance <= 0),
    ('W2', t.fare_amount <= 0),
    ('W3', t.trip_distance > 100),
    ('W4', t.fare_amount > 500),
    ('W5', d.secs > 6 * 3600),
    ('W6', t.dropoff_location_id IS NULL OR dz.geom IS NULL),
    ('W7', t.payment_type_id = 6),
    ('W8', d.secs > 0 AND t.trip_distance * 3600 / d.secs > 80),
    ('W9', d.secs = 0)
) AS w(code, hit)
WHERE t.import_batch_id = %(batch)s
  AND t.pickup_ts >= %(start)s AND t.pickup_ts < %(end)s
  AND w.hit
"""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def step(msg: str, t0: list) -> None:
    now = time.perf_counter()
    print(f"  {msg} ({now - t0[0]:.1f}s)")
    t0[0] = now


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--month", required=True, help="YYYY-MM")
    ap.add_argument("--file", type=Path, help="parquet file (default data/trips/yellow_tripdata_<month>.parquet)")
    args = ap.parse_args()

    start = parse_month(args.month)
    end = next_month(start)
    path = args.file or DATA / "trips" / f"yellow_tripdata_{args.month}.parquet"
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 1

    t0 = [time.perf_counter()]
    checksum = sha256(path)
    print(f"{path.name}  sha256 {checksum}")

    # autocommit, so conn.transaction() below is the one real transaction
    with pg_connect(autocommit=True) as conn:
        dup = conn.execute(
            "SELECT import_batch_id, finished_at FROM import_batch WHERE checksum_sha256 = %s",
            (checksum,),
        ).fetchone()
        if dup:
            print(
                f"R5: this file was already imported as batch {dup[0]} "
                f"(finished {dup[1]:%Y-%m-%d %H:%M}). Nothing to do.",
                file=sys.stderr,
            )
            return 2
        same_month = conn.execute(
            "SELECT import_batch_id, source_file, checksum_sha256 FROM import_batch WHERE file_month = %s",
            (start,),
        ).fetchone()
        if same_month:
            print(
                f"R5: {args.month} was already imported as batch {same_month[0]} from "
                f"{same_month[1]} (sha256 {same_month[2][:16]}...), and this file is different "
                f"(sha256 {checksum[:16]}...). Nothing was imported. If TLC republished the "
                f"month, agree it with the team, then start fresh with docker compose down -v.",
                file=sys.stderr,
            )
            return 2

        df = pl.read_parquet(path)
        missing = set(COLUMNS) - set(df.columns)
        if missing:
            print(f"file is missing expected columns: {sorted(missing)}", file=sys.stderr)
            return 1
        df = df.select([pl.col(src).alias(dst) for src, dst in COLUMNS.items()])
        rows_read = df.height
        step(f"read {rows_read:,} rows", t0)

        with conn.transaction(), conn.cursor() as cur:
            batch_id = cur.execute(
                """INSERT INTO import_batch (source_file, file_month, checksum_sha256)
                   VALUES (%s, %s, %s) RETURNING import_batch_id""",
                (path.name, start, checksum),
            ).fetchone()[0]

            part = f"trip_{start:%Y_%m}"
            cur.execute(
                f"CREATE TABLE IF NOT EXISTS {part} PARTITION OF trip "
                f"FOR VALUES FROM ('{start}') TO ('{end}')"
            )

            df = df.with_columns(
                pl.lit(batch_id).alias("import_batch_id"),
                pl.int_range(1, rows_read + 1).alias("source_row_number"),
            ).select(["import_batch_id", "source_row_number", *RAW_COLS])

            cur.execute("TRUNCATE trip_staging")
            cols = ", ".join(df.columns)
            with cur.copy(f"COPY trip_staging ({cols}) FROM STDIN (FORMAT csv)") as copy:
                for offset in range(0, rows_read, COPY_CHUNK):
                    buf = io.BytesIO()
                    df.slice(offset, COPY_CHUNK).write_csv(
                        buf, include_header=False, datetime_format="%Y-%m-%d %H:%M:%S%.f"
                    )
                    copy.write(buf.getvalue())
            step("copied into trip_staging", t0)

            params = {"batch": batch_id, "start": start, "end": end}
            cur.execute(CLASSIFY_SQL, params)
            cur.execute("CREATE INDEX ON staged (source_row_number)")
            cur.execute(REVERSAL_SQL)
            step("sorted rows", t0)

            cur.execute(INSERT_REJECTED_SQL)
            rejected = cur.rowcount
            cur.execute(INSERT_TRIPS_SQL)
            accepted = cur.rowcount
            step(f"inserted {accepted:,} trips, {rejected:,} rejected rows", t0)

            cur.execute(INSERT_WARNINGS_SQL, params)
            warnings = cur.rowcount
            warned = cur.execute(
                """SELECT count(*) FROM (SELECT DISTINCT source_row_number FROM trip_warning
                   WHERE import_batch_id = %s) x""",
                (batch_id,),
            ).fetchone()[0]
            step(f"recorded {warnings:,} warnings on {warned:,} trips", t0)

            if accepted + rejected != rows_read:
                raise RuntimeError(
                    f"row count mismatch: {accepted} + {rejected} != {rows_read}"
                )

            cur.execute(
                """UPDATE import_batch
                      SET rows_read = %s, rows_accepted = %s, rows_rejected = %s,
                          rows_warned = %s, status = 'completed', finished_at = clock_timestamp()
                    WHERE import_batch_id = %s""",
                (rows_read, accepted, rejected, warned, batch_id),
            )
            cur.execute("TRUNCATE trip_staging")

        conn.execute(f"ANALYZE trip_{start:%Y_%m}")
        conn.execute("ANALYZE trip_warning")
        conn.execute("ANALYZE rejected_trip")

        print(f"\nbatch {batch_id}: read {rows_read:,}  accepted {accepted:,}  "
              f"rejected {rejected:,}  warned {warned:,}")
        for code, n in conn.execute(
            """SELECT reason_code, count(*) FROM rejected_trip
               WHERE import_batch_id = %s GROUP BY 1 ORDER BY 1""", (batch_id,)):
            print(f"  {code}: {n:,}")
        for code, n in conn.execute(
            """SELECT code, count(*) FROM trip_warning
               WHERE import_batch_id = %s GROUP BY 1 ORDER BY 1""", (batch_id,)):
            print(f"  {code}: {n:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
