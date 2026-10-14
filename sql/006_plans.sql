-- Allocation plans. Versions and results are weak entities under a plan.

CREATE TABLE IF NOT EXISTS allocation_plan (
    allocation_plan_id  serial PRIMARY KEY,
    owner_user_id       int NOT NULL REFERENCES app_user ON DELETE CASCADE,
    name                text NOT NULL CHECK (length(trim(name)) > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, name)
);

CREATE TABLE IF NOT EXISTS allocation_plan_version (
    allocation_plan_id  int NOT NULL REFERENCES allocation_plan ON DELETE CASCADE,
    version_no          int NOT NULL CHECK (version_no >= 1),
    fleet_size          int NOT NULL CHECK (fleet_size > 0),
    iso_dow             smallint NOT NULL CHECK (iso_dow BETWEEN 1 AND 7),
    start_hour          smallint NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
    end_hour            smallint NOT NULL CHECK (end_hour BETWEEN 0 AND 23),
    max_zones_per_hour  int NOT NULL DEFAULT 10 CHECK (max_zones_per_hour > 0),
    min_sample          int NOT NULL DEFAULT 30 CHECK (min_sample >= 0),
    w_pickup            numeric(4,3) NOT NULL DEFAULT 0.50 CHECK (w_pickup >= 0),
    w_imbalance         numeric(4,3) NOT NULL DEFAULT 0.25 CHECK (w_imbalance >= 0),
    w_consistency       numeric(4,3) NOT NULL DEFAULT 0.15 CHECK (w_consistency >= 0),
    w_fare              numeric(4,3) NOT NULL DEFAULT 0.10 CHECK (w_fare >= 0),
    note                text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (allocation_plan_id, version_no),
    CHECK (start_hour <= end_hour),
    CHECK (w_pickup + w_imbalance + w_consistency + w_fare = 1)
);

CREATE TABLE IF NOT EXISTS allocation_plan_version_borough (
    allocation_plan_id  int NOT NULL,
    version_no          int NOT NULL,
    borough_id          smallint NOT NULL REFERENCES borough,
    PRIMARY KEY (allocation_plan_id, version_no, borough_id),
    FOREIGN KEY (allocation_plan_id, version_no)
        REFERENCES allocation_plan_version ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS allocation_result (
    allocation_plan_id  int NOT NULL,
    version_no          int NOT NULL,
    hour                smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
    location_id         smallint NOT NULL REFERENCES taxi_zone,
    proposed_taxis      int NOT NULL CHECK (proposed_taxis >= 0),
    final_taxis         int NOT NULL CHECK (final_taxis >= 0),
    score               numeric(6,5) NOT NULL CHECK (score BETWEEN 0 AND 1),
    rank                smallint NOT NULL CHECK (rank >= 1),
    sample_size         int NOT NULL CHECK (sample_size >= 0),
    reason              text NOT NULL,
    PRIMARY KEY (allocation_plan_id, version_no, hour, location_id),
    FOREIGN KEY (allocation_plan_id, version_no)
        REFERENCES allocation_plan_version ON DELETE CASCADE
);

-- Each hour's final allocations must add up exactly to the fleet size.
-- Deferred, so it runs once when the whole version is committed.
CREATE OR REPLACE FUNCTION check_allocation_hour_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    r       record;
    fleet   int;
    total   int;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

    SELECT v.fleet_size INTO fleet
    FROM allocation_plan_version v
    WHERE v.allocation_plan_id = r.allocation_plan_id AND v.version_no = r.version_no;

    IF NOT FOUND THEN
        RETURN NULL;   -- whole version deleted
    END IF;

    SELECT sum(final_taxis) INTO total
    FROM allocation_result
    WHERE allocation_plan_id = r.allocation_plan_id
      AND version_no = r.version_no
      AND hour = r.hour;

    IF total IS NOT NULL AND total <> fleet THEN
        RAISE EXCEPTION 'plan % version % hour %: allocations add up to %, fleet size is %',
            r.allocation_plan_id, r.version_no, r.hour, total, fleet
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS allocation_result_hour_total ON allocation_result;
CREATE CONSTRAINT TRIGGER allocation_result_hour_total
    AFTER INSERT OR UPDATE OR DELETE ON allocation_result
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_allocation_hour_total();

CREATE OR REPLACE VIEW v_plan_summary AS
SELECT p.allocation_plan_id,
       p.owner_user_id,
       p.name,
       p.created_at,
       p.updated_at,
       v.version_no              AS latest_version,
       v.fleet_size,
       v.iso_dow,
       v.start_hour,
       v.end_hour,
       coalesce(r.total_taxis, 0)  AS total_taxis,
       coalesce(r.zones_covered, 0) AS zones_covered
FROM allocation_plan p
LEFT JOIN LATERAL (
    SELECT * FROM allocation_plan_version pv
    WHERE pv.allocation_plan_id = p.allocation_plan_id
    ORDER BY pv.version_no DESC
    LIMIT 1
) v ON true
LEFT JOIN LATERAL (
    SELECT sum(ar.final_taxis)::int AS total_taxis,
           count(DISTINCT ar.location_id)::int AS zones_covered
    FROM allocation_result ar
    WHERE ar.allocation_plan_id = v.allocation_plan_id AND ar.version_no = v.version_no
) r ON true;
