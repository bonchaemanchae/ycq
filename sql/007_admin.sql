-- Admin: reconciliation runs and benchmark results.

CREATE TABLE IF NOT EXISTS reconciliation_run (
    reconciliation_run_id  serial PRIMARY KEY,
    month                  date NOT NULL,
    started_at             timestamptz NOT NULL DEFAULT now(),
    finished_at            timestamptz,
    passed                 boolean,
    pg_hour_rows           int,
    mongo_hour_docs        int,
    pg_pickups             bigint,
    mongo_pickups          bigint,
    pg_dropoffs            bigint,
    mongo_dropoffs         bigint,
    zone_hour_mismatches   int,
    od_mismatches          int,
    details                jsonb
);

CREATE TABLE IF NOT EXISTS benchmark_run (
    benchmark_run_id  serial PRIMARY KEY,
    run_at            timestamptz NOT NULL DEFAULT now(),
    store             text NOT NULL CHECK (store IN ('postgres', 'mongo_collection', 'mongo_timeseries')),
    query_name        text NOT NULL,
    runs              int NOT NULL CHECK (runs > 0),
    cold_ms           numeric(12,3),
    median_ms         numeric(12,3),
    p95_ms            numeric(12,3),
    storage_bytes     bigint,
    index_bytes       bigint,
    load_ms           numeric(12,3),
    plan_output       text
);
