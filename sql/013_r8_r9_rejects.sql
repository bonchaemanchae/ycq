-- Two reject rules so that one bad row can't abort a whole month's import.
-- Before these, such a row passed the loose staging table but then failed a
-- foreign key, CHECK or numeric(p,s) column on trip, which rolled back the
-- entire import.
--
-- R8: a vendor, payment type or rate code that isn't in its lookup table.
--     Rate code 99 (unknown) and a missing rate code are still accepted and
--     stored as NULL.
-- R9: an impossible value: a negative passenger count, or a passenger count,
--     distance or money amount too large for its column or not a number
--     (NaN or infinity).

INSERT INTO validation_code (code, kind, description) VALUES
    ('R8', 'reject', 'Unknown vendor, payment type or rate code'),
    ('R9', 'reject', 'Impossible value: negative passengers, or a number out of range or not a number')
ON CONFLICT (code) DO NOTHING;
