-- Saved plan versions are history: they can't be changed afterwards, and every
-- result must use a zone the version allows.
--
-- 1. A saved version, its boroughs and its results can't be updated, and
--    can't be deleted on their own. A change is saved as a new version; the
--    only way to remove a version is to delete its whole plan, which cascades.
--    (011 only checked a version on INSERT, so an UPDATE of fleet_size or
--    end_hour could leave a stored plan breaking its own rules.)
-- 2. Each result's zone must have a map shape and be in one of the version's
--    boroughs. Deferred, so it runs once when the whole version is committed.

CREATE OR REPLACE FUNCTION refuse_plan_history_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'saved plan versions can''t be changed (%); save a new version instead',
            TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;

    -- DELETE: allowed only as part of deleting the parent, which the foreign
    -- key cascade does after the parent row is already gone.
    IF TG_TABLE_NAME = 'allocation_plan_version' THEN
        IF EXISTS (SELECT 1 FROM allocation_plan WHERE allocation_plan_id = OLD.allocation_plan_id) THEN
            RAISE EXCEPTION 'plan % version % can''t be deleted on its own; delete the whole plan',
                OLD.allocation_plan_id, OLD.version_no
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM allocation_plan_version
                  WHERE allocation_plan_id = OLD.allocation_plan_id AND version_no = OLD.version_no) THEN
        RAISE EXCEPTION 'saved plan versions can''t be changed (%); save a new version instead',
            TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS allocation_plan_version_immutable ON allocation_plan_version;
CREATE TRIGGER allocation_plan_version_immutable
    BEFORE UPDATE OR DELETE ON allocation_plan_version
    FOR EACH ROW EXECUTE FUNCTION refuse_plan_history_change();

DROP TRIGGER IF EXISTS allocation_plan_version_borough_immutable ON allocation_plan_version_borough;
CREATE TRIGGER allocation_plan_version_borough_immutable
    BEFORE UPDATE OR DELETE ON allocation_plan_version_borough
    FOR EACH ROW EXECUTE FUNCTION refuse_plan_history_change();

DROP TRIGGER IF EXISTS allocation_result_immutable ON allocation_result;
CREATE TRIGGER allocation_result_immutable
    BEFORE UPDATE OR DELETE ON allocation_result
    FOR EACH ROW EXECUTE FUNCTION refuse_plan_history_change();


CREATE OR REPLACE FUNCTION check_allocation_zone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM allocation_plan_version
                   WHERE allocation_plan_id = NEW.allocation_plan_id
                     AND version_no = NEW.version_no) THEN
        RETURN NULL;   -- version deleted again in the same transaction
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM taxi_zone z
        JOIN allocation_plan_version_borough vb ON vb.borough_id = z.borough_id
        WHERE z.location_id = NEW.location_id
          AND z.geom IS NOT NULL
          AND vb.allocation_plan_id = NEW.allocation_plan_id
          AND vb.version_no = NEW.version_no) THEN
        RAISE EXCEPTION 'plan % version %: zone % is not in the plan''s boroughs or has no map shape',
            NEW.allocation_plan_id, NEW.version_no, NEW.location_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS allocation_result_zone ON allocation_result;
CREATE CONSTRAINT TRIGGER allocation_result_zone
    AFTER INSERT ON allocation_result
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_allocation_zone();
