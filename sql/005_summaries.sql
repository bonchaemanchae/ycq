-- Summaries rebuilt from trip. Both are deliberate, rebuildable copies.

-- Which averages each trip may feed, from its warnings.
--   W1, W3, W8 -> out of distance averages
--   W5, W8, W9 -> out of duration averages (W9 added in 008)
--   W2, W4     -> out of fare statistics (fare stats also need a metered trip, fare > 0)
--   W6         -> out of drop-off counts
--   W7         -> out of every summary
CREATE OR REPLACE VIEW v_trip_flags AS
SELECT import_batch_id, source_row_number, pickup_ts,
       bool_or(code IN ('W1', 'W3', 'W8')) AS skip_distance,
       bool_or(code IN ('W5', 'W8'))       AS skip_duration,
       bool_or(code IN ('W2', 'W4'))       AS skip_fare,
       bool_or(code = 'W6')                AS skip_dropoff,
       bool_or(code = 'W7')                AS skip_all
FROM trip_warning
GROUP BY import_batch_id, source_row_number, pickup_ts;

-- Flow Explorer time-of-day buckets.
CREATE OR REPLACE FUNCTION time_bucket_of(ts timestamp) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN extract(hour FROM ts) < 6  THEN 'night'
        WHEN extract(hour FROM ts) < 10 THEN 'am_peak'
        WHEN extract(hour FROM ts) < 16 THEN 'midday'
        WHEN extract(hour FROM ts) < 20 THEN 'pm_peak'
        ELSE 'evening'
    END
$$;

-- One row per zone (with a map shape) per local hour, including hours with no
-- trips. Pickups are counted at the pickup zone/hour, drop-offs at the
-- drop-off zone/hour. Sums and counts are stored so averages over many hours
-- are sum/count, never an average of averages.
CREATE TABLE IF NOT EXISTS zone_hour_observation (
    location_id          smallint NOT NULL REFERENCES taxi_zone,
    obs_hour             timestamp NOT NULL,   -- New York local hour start
    obs_hour_utc         timestamptz NOT NULL,
    local_date           date NOT NULL,
    local_hour           smallint NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
    iso_dow              smallint NOT NULL CHECK (iso_dow BETWEEN 1 AND 7),
    pickups              int NOT NULL DEFAULT 0 CHECK (pickups >= 0),
    dropoffs             int NOT NULL DEFAULT 0 CHECK (dropoffs >= 0),
    fare_sum             numeric(14,2) NOT NULL DEFAULT 0,
    fare_trip_count      int NOT NULL DEFAULT 0,
    distance_sum         numeric(14,2) NOT NULL DEFAULT 0,
    distance_trip_count  int NOT NULL DEFAULT 0,
    duration_sum_s       bigint NOT NULL DEFAULT 0,
    duration_trip_count  int NOT NULL DEFAULT 0,
    PRIMARY KEY (location_id, obs_hour)
);

CREATE INDEX IF NOT EXISTS zone_hour_obs_hour_idx ON zone_hour_observation (obs_hour);
CREATE INDEX IF NOT EXISTS zone_hour_dow_hour_idx ON zone_hour_observation (iso_dow, local_hour);

-- Zone-to-zone flows by month, day type and time of day.
CREATE MATERIALIZED VIEW IF NOT EXISTS od_summary AS
SELECT date_trunc('month', t.pickup_ts)::date                       AS month,
       CASE WHEN extract(isodow FROM t.pickup_ts) >= 6
            THEN 'weekend' ELSE 'weekday' END                      AS day_type,
       time_bucket_of(t.pickup_ts)                                 AS time_bucket,
       t.pickup_location_id                                        AS origin_location_id,
       t.dropoff_location_id                                       AS dest_location_id,
       count(*)::int                                               AS trips,
       coalesce(sum(t.fare_amount) FILTER (WHERE fare_ok), 0)      AS fare_sum,
       count(*) FILTER (WHERE fare_ok)::int                        AS fare_trip_count,
       coalesce(sum(t.trip_distance) FILTER (WHERE dist_ok), 0)    AS distance_sum,
       count(*) FILTER (WHERE dist_ok)::int                        AS distance_trip_count,
       coalesce(sum(extract(epoch FROM t.dropoff_ts - t.pickup_ts))
                FILTER (WHERE dur_ok), 0)::bigint                  AS duration_sum_s,
       count(*) FILTER (WHERE dur_ok)::int                         AS duration_trip_count
FROM (
    SELECT t.*,
           (t.payment_type_id <> 0 AND t.fare_amount > 0
                AND NOT coalesce(f.skip_fare, false))              AS fare_ok,
           NOT coalesce(f.skip_distance, false)                    AS dist_ok,
           NOT coalesce(f.skip_duration, false)                    AS dur_ok
    FROM trip t
    LEFT JOIN v_trip_flags f USING (import_batch_id, source_row_number, pickup_ts)
    WHERE NOT coalesce(f.skip_all, false)
      AND NOT coalesce(f.skip_dropoff, false)
) t
GROUP BY 1, 2, 3, 4, 5
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS od_summary_uq
    ON od_summary (month, day_type, time_bucket, origin_location_id, dest_location_id);
