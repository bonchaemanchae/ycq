-- Benchmark questions Q6 and Q7 (etl/benchmark.py) also time the pre-summed
-- MongoDB collections the Activity Dashboard reads, recorded as the store
-- 'mongo_summary'.

ALTER TABLE benchmark_run DROP CONSTRAINT IF EXISTS benchmark_run_store_check;
ALTER TABLE benchmark_run ADD CONSTRAINT benchmark_run_store_check
    CHECK (store IN ('postgres', 'mongo_collection', 'mongo_timeseries', 'mongo_summary'));
