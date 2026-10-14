-- W9: drop-off time not recorded (equal to the pickup time). Vendor 7 sends
-- every trip this way. The trip and its distance are fine; only its duration
-- is unknown, so W9 keeps it out of duration averages and nothing else.
-- W8 (implied speed) now only applies to trips with a real duration.

INSERT INTO validation_code (code, kind, description) VALUES
    ('W9', 'warn', 'Drop-off time not recorded (same as pickup time)')
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE VIEW v_trip_flags AS
SELECT import_batch_id, source_row_number, pickup_ts,
       bool_or(code IN ('W1', 'W3', 'W8')) AS skip_distance,
       bool_or(code IN ('W5', 'W8', 'W9')) AS skip_duration,
       bool_or(code IN ('W2', 'W4'))       AS skip_fare,
       bool_or(code = 'W6')                AS skip_dropoff,
       bool_or(code = 'W7')                AS skip_all
FROM trip_warning
GROUP BY import_batch_id, source_row_number, pickup_ts;
