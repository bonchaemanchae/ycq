-- Import tables: batches, loose staging, partitioned trips, warnings and rejects.

CREATE TABLE IF NOT EXISTS import_batch (
    import_batch_id  serial PRIMARY KEY,
    source_file      text NOT NULL,
    file_month       date NOT NULL CHECK (date_trunc('month', file_month) = file_month),
    checksum_sha256  char(64) NOT NULL UNIQUE,   -- R5: a file can't be imported twice
    rows_read        int,
    rows_accepted    int,
    rows_rejected    int,
    rows_warned      int,
    status           text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'completed')),
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    CHECK (rows_accepted + rows_rejected = rows_read)
);

-- Loose staging table: every column nullable and no constraints, so the raw
-- COPY can't fail. Rows are sorted by SQL afterwards. Unlogged because it is
-- emptied after every import.
CREATE UNLOGGED TABLE IF NOT EXISTS trip_staging (
    import_batch_id        int,
    source_row_number      int,
    vendor_id              bigint,
    pickup_ts              timestamp,
    dropoff_ts             timestamp,
    passenger_count        bigint,
    trip_distance          double precision,
    rate_code_id           bigint,
    store_and_fwd_flag     text,
    pickup_location_id     bigint,
    dropoff_location_id    bigint,
    payment_type_id        bigint,
    fare_amount            double precision,
    extra                  double precision,
    mta_tax                double precision,
    tip_amount             double precision,
    tolls_amount           double precision,
    improvement_surcharge  double precision,
    total_amount           double precision,
    congestion_surcharge   double precision,
    airport_fee            double precision,
    cbd_congestion_fee     double precision
);

-- Accepted trips, one partition per month. Times are New York local time.
CREATE TABLE IF NOT EXISTS trip (
    import_batch_id        int NOT NULL REFERENCES import_batch,
    source_row_number      int NOT NULL,
    pickup_ts              timestamp NOT NULL,
    dropoff_ts             timestamp NOT NULL,
    vendor_id              smallint NOT NULL REFERENCES vendor,
    passenger_count        smallint CHECK (passenger_count >= 0),
    trip_distance          numeric(9,2),
    rate_code_id           smallint REFERENCES rate_code,     -- 99 (unknown) loaded as NULL
    store_and_fwd_flag     boolean,
    pickup_location_id     smallint NOT NULL REFERENCES taxi_zone,
    dropoff_location_id    smallint REFERENCES taxi_zone,     -- NULL when not a known zone (W6)
    payment_type_id        smallint NOT NULL REFERENCES payment_type,
    fare_amount            numeric(12,2),
    extra                  numeric(12,2),
    mta_tax                numeric(12,2),
    tip_amount             numeric(12,2),
    tolls_amount           numeric(12,2),
    improvement_surcharge  numeric(12,2),
    total_amount           numeric(12,2),   -- as given; never rebuilt from its parts
    congestion_surcharge   numeric(12,2),
    airport_fee            numeric(12,2),
    cbd_congestion_fee     numeric(12,2),
    PRIMARY KEY (import_batch_id, source_row_number, pickup_ts),
    CONSTRAINT trip_dropoff_after_pickup CHECK (dropoff_ts >= pickup_ts)
) PARTITION BY RANGE (pickup_ts);

-- Indexes on the parent are created on every partition.
CREATE INDEX IF NOT EXISTS trip_pickup_ts_brin ON trip USING brin (pickup_ts);
CREATE INDEX IF NOT EXISTS trip_pu_zone_ts_idx ON trip (pickup_location_id, pickup_ts);
CREATE INDEX IF NOT EXISTS trip_do_zone_ts_idx ON trip (dropoff_location_id, dropoff_ts);

CREATE TABLE IF NOT EXISTS trip_warning (
    import_batch_id    int NOT NULL,
    source_row_number  int NOT NULL,
    pickup_ts          timestamp NOT NULL,
    code               varchar(3) NOT NULL REFERENCES validation_code,
    PRIMARY KEY (import_batch_id, source_row_number, pickup_ts, code),
    FOREIGN KEY (import_batch_id, source_row_number, pickup_ts)
        REFERENCES trip ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trip_warning_code_idx ON trip_warning (code);

-- Rejected rows keep their raw values plus the reason.
CREATE TABLE IF NOT EXISTS rejected_trip (
    rejected_id            bigserial PRIMARY KEY,
    import_batch_id        int NOT NULL REFERENCES import_batch,
    source_row_number      int NOT NULL,
    reason_code            varchar(3) NOT NULL REFERENCES validation_code,
    vendor_id              bigint,
    pickup_ts              timestamp,
    dropoff_ts             timestamp,
    passenger_count        bigint,
    trip_distance          double precision,
    rate_code_id           bigint,
    store_and_fwd_flag     text,
    pickup_location_id     bigint,
    dropoff_location_id    bigint,
    payment_type_id        bigint,
    fare_amount            double precision,
    extra                  double precision,
    mta_tax                double precision,
    tip_amount             double precision,
    tolls_amount           double precision,
    improvement_surcharge  double precision,
    total_amount           double precision,
    congestion_surcharge   double precision,
    airport_fee            double precision,
    cbd_congestion_fee     double precision,
    UNIQUE (import_batch_id, source_row_number)
);

CREATE INDEX IF NOT EXISTS rejected_trip_reason_idx ON rejected_trip (import_batch_id, reason_code);
