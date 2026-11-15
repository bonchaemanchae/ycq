-- Results of the load test (etl/load_test.py): one row per question and number
-- of simultaneous users. The rows of one test share run_at, like benchmark_run.

CREATE TABLE IF NOT EXISTS load_test_run (
    load_test_run_id  serial PRIMARY KEY,
    run_at            timestamptz NOT NULL DEFAULT now(),
    question          text NOT NULL,
    users             int NOT NULL CHECK (users > 0),
    seconds           numeric(8,1) NOT NULL CHECK (seconds > 0),
    requests          int NOT NULL CHECK (requests >= 0),
    failed            int NOT NULL CHECK (failed >= 0),
    requests_per_sec  numeric(10,2) NOT NULL,
    median_ms         numeric(12,3),
    p95_ms            numeric(12,3)
);
