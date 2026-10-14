-- Median metered fare for every zone, weekday and hour, used by the
-- allocation planner. A median can't be built from the hourly sums in
-- zone_hour_observation (or MongoDB), and computing it from trip at plan time
-- means scanning every trip, so it is precomputed here from all loaded months.
-- Same fare rules as the other fare statistics: metered trips only (not Flex
-- Fare), fare above 0, no W2, W4 or W7.

CREATE MATERIALIZED VIEW IF NOT EXISTS zone_weekday_hour_fare AS
SELECT t.pickup_location_id                                        AS location_id,
       extract(isodow FROM t.pickup_ts)::smallint                  AS iso_dow,
       extract(hour FROM t.pickup_ts)::smallint                    AS local_hour,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY t.fare_amount)::numeric(12,2)
                                                                   AS median_fare,
       count(*)::int                                               AS fare_trip_count
FROM trip t
LEFT JOIN v_trip_flags f USING (import_batch_id, source_row_number, pickup_ts)
WHERE t.payment_type_id <> 0
  AND t.fare_amount > 0
  AND NOT coalesce(f.skip_fare, false)
  AND NOT coalesce(f.skip_all, false)
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS zone_weekday_hour_fare_pk
    ON zone_weekday_hour_fare (location_id, iso_dow, local_hour);
