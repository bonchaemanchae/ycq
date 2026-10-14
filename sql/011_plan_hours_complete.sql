-- Every hour of a saved plan version must be fully allocated.
--
-- The row trigger from 006 only checked hours that had result rows, so a
-- version with an hour missing altogether, or a result outside the version's
-- hours, could be saved. Now:
--   * each result row must fall between the version's start and end hour;
--   * each hour it touches (on UPDATE, the old hour too) must still add up to
--     the fleet size, and an hour emptied by a DELETE is refused;
--   * a new version must have results for every hour from start to end.
-- Both triggers are deferred, so they run once when the save commits.

CREATE OR REPLACE FUNCTION check_allocation_hour_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v       record;
    h       smallint;
    total   int;
    plan_id int;
    ver_no  int;
BEGIN
    IF TG_OP = 'DELETE' THEN
        plan_id := OLD.allocation_plan_id;  ver_no := OLD.version_no;
    ELSE
        plan_id := NEW.allocation_plan_id;  ver_no := NEW.version_no;
    END IF;

    SELECT fleet_size, start_hour, end_hour INTO v
    FROM allocation_plan_version
    WHERE allocation_plan_id = plan_id AND version_no = ver_no;

    IF NOT FOUND THEN
        RETURN NULL;   -- whole version deleted
    END IF;

    IF TG_OP <> 'DELETE' AND NEW.hour NOT BETWEEN v.start_hour AND v.end_hour THEN
        RAISE EXCEPTION 'plan % version %: hour % is outside the plan hours % to %',
            plan_id, ver_no, NEW.hour, v.start_hour, v.end_hour
            USING ERRCODE = 'check_violation';
    END IF;

    FOREACH h IN ARRAY (
        CASE TG_OP
            WHEN 'INSERT' THEN ARRAY[NEW.hour]
            WHEN 'DELETE' THEN ARRAY[OLD.hour]
            ELSE ARRAY[NEW.hour, OLD.hour]
        END)
    LOOP
        CONTINUE WHEN h NOT BETWEEN v.start_hour AND v.end_hour;

        SELECT sum(final_taxis) INTO total
        FROM allocation_result
        WHERE allocation_plan_id = plan_id AND version_no = ver_no AND hour = h;

        IF total IS NULL THEN
            RAISE EXCEPTION 'plan % version %: hour % has no allocations',
                plan_id, ver_no, h
                USING ERRCODE = 'check_violation';
        ELSIF total <> v.fleet_size THEN
            RAISE EXCEPTION 'plan % version % hour %: allocations add up to %, fleet size is %',
                plan_id, ver_no, h, total, v.fleet_size
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION check_plan_version_hours() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    missing int[];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM allocation_plan_version
                   WHERE allocation_plan_id = NEW.allocation_plan_id
                     AND version_no = NEW.version_no) THEN
        RETURN NULL;   -- version deleted again in the same transaction
    END IF;

    SELECT array_agg(g.h ORDER BY g.h) INTO missing
    FROM generate_series(NEW.start_hour::int, NEW.end_hour::int) AS g(h)
    WHERE NOT EXISTS (
        SELECT 1 FROM allocation_result r
        WHERE r.allocation_plan_id = NEW.allocation_plan_id
          AND r.version_no = NEW.version_no
          AND r.hour = g.h);

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'plan % version %: no allocations for hour(s) %',
            NEW.allocation_plan_id, NEW.version_no, array_to_string(missing, ', ')
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS allocation_plan_version_hours ON allocation_plan_version;
CREATE CONSTRAINT TRIGGER allocation_plan_version_hours
    AFTER INSERT ON allocation_plan_version
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_plan_version_hours();
