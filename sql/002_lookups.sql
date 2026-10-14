-- Lookup tables, seeded with every value found in the TLC data.

CREATE TABLE IF NOT EXISTS vendor (
    vendor_id    smallint PRIMARY KEY,
    name         text NOT NULL
);

INSERT INTO vendor (vendor_id, name) VALUES
    (1, 'Creative Mobile Technologies, LLC'),
    (2, 'Curb Mobility, LLC'),
    (6, 'Myle Technologies Inc'),
    (7, 'Helix')
ON CONFLICT (vendor_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_type (
    payment_type_id  smallint PRIMARY KEY,
    name             text NOT NULL
);

INSERT INTO payment_type (payment_type_id, name) VALUES
    (0, 'Flex Fare trip'),
    (1, 'Credit card'),
    (2, 'Cash'),
    (3, 'No charge'),
    (4, 'Dispute'),
    (5, 'Unknown'),
    (6, 'Voided trip')
ON CONFLICT (payment_type_id) DO NOTHING;

-- Rate code 99 (unknown) is stored as NULL on trip, not as a lookup row.
CREATE TABLE IF NOT EXISTS rate_code (
    rate_code_id  smallint PRIMARY KEY,
    name          text NOT NULL
);

INSERT INTO rate_code (rate_code_id, name) VALUES
    (1, 'Standard rate'),
    (2, 'JFK'),
    (3, 'Newark'),
    (4, 'Nassau or Westchester'),
    (5, 'Negotiated fare'),
    (6, 'Group ride')
ON CONFLICT (rate_code_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS validation_code (
    code         varchar(3) PRIMARY KEY,
    kind         text NOT NULL CHECK (kind IN ('reject', 'warn')),
    description  text NOT NULL
);

INSERT INTO validation_code (code, kind, description) VALUES
    ('R1', 'reject', 'Pickup or drop-off time missing'),
    ('R2', 'reject', 'Drop-off before pickup'),
    ('R3', 'reject', 'Pickup outside the file''s month'),
    ('R4', 'reject', 'Pickup zone missing or has no map shape'),
    ('R5', 'reject', 'Whole file already imported (same checksum)'),
    ('R6', 'reject', 'Trip longer than 24 hours'),
    ('R7', 'reject', 'Reversal of another trip in the same file'),
    ('W1', 'warn',   'Distance 0 or less'),
    ('W2', 'warn',   'Fare 0 or less'),
    ('W3', 'warn',   'Distance over 100 miles'),
    ('W4', 'warn',   'Fare over $500'),
    ('W5', 'warn',   'Duration over 6 hours'),
    ('W6', 'warn',   'Drop-off zone missing or has no map shape'),
    ('W7', 'warn',   'Voided trip (payment type 6)'),
    ('W8', 'warn',   'Implied speed over 80 mph')
ON CONFLICT (code) DO NOTHING;
