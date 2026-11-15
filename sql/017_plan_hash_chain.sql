-- Saved plan versions as a hash chain, so a change made behind the triggers
-- can be detected afterwards.
--
-- The immutability triggers (sql/012) stop the API changing a saved version,
-- but the database owner can switch a trigger off, edit a row and switch it
-- back on, and nothing would show. So when a version is committed it is
-- sealed: one row in allocation_plan_version_seal holding
--
--   hash       SHA-256 of prev_hash followed by the version's settings, its
--              boroughs and every result row
--   prev_hash  the hash of the plan's version before it (NULL for the first)
--
-- Each plan is its own chain. Editing a sealed version changes what its hash
-- should be; replacing its seal to match breaks the next version's
-- prev_hash. plan_seal_check() recomputes every hash and reports both.
--
-- What it can't detect: someone who rewrites a version and every seal after
-- it, or removes a plan's newest version. A chain kept in one place shows
-- tampering only to whoever kept a copy of its latest hash, which is why the
-- Planner shows each version's hash.
--
-- The API's role can read seals but not write them: the sealing trigger runs
-- with the owner's rights. Safe to run again.

CREATE TABLE IF NOT EXISTS allocation_plan_version_seal (
    allocation_plan_id  int NOT NULL,
    version_no          int NOT NULL,
    prev_hash           text CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
    hash                text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    sealed_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (allocation_plan_id, version_no),
    FOREIGN KEY (allocation_plan_id, version_no)
        REFERENCES allocation_plan_version ON DELETE CASCADE
);

-- A version's hash, given the hash before it. Everything is put in a JSON
-- array in a fixed order, so the text hashed is the same on every server:
-- the time is seconds since 1970 rather than text that follows the session's
-- time zone, and rows are sorted by their keys.
CREATE OR REPLACE FUNCTION plan_version_hash(p_plan int, p_version int, p_prev text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT encode(sha256(convert_to(coalesce(p_prev, '') || jsonb_build_array(
               v.allocation_plan_id, v.version_no, v.fleet_size, v.iso_dow, v.start_hour, v.end_hour,
               v.max_zones_per_hour, v.min_sample, v.w_pickup, v.w_imbalance, v.w_consistency,
               v.w_fare, v.note, extract(epoch FROM v.created_at),
               (SELECT jsonb_agg(vb.borough_id ORDER BY vb.borough_id)
                FROM allocation_plan_version_borough vb
                WHERE vb.allocation_plan_id = v.allocation_plan_id AND vb.version_no = v.version_no),
               (SELECT jsonb_agg(jsonb_build_array(r.hour, r.location_id, r.proposed_taxis, r.final_taxis,
                                                   r.score, r.rank, r.sample_size, r.reason)
                                 ORDER BY r.hour, r.location_id)
                FROM allocation_result r
                WHERE r.allocation_plan_id = v.allocation_plan_id AND r.version_no = v.version_no)
           )::text, 'UTF8')), 'hex')
    FROM allocation_plan_version v
    WHERE v.allocation_plan_id = p_plan AND v.version_no = p_version
$$;

CREATE OR REPLACE FUNCTION seal_plan_version(p_plan int, p_version int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    prev text;
BEGIN
    SELECT s.hash INTO prev
    FROM allocation_plan_version_seal s
    WHERE s.allocation_plan_id = p_plan AND s.version_no < p_version
    ORDER BY s.version_no DESC
    LIMIT 1;

    INSERT INTO allocation_plan_version_seal (allocation_plan_id, version_no, prev_hash, hash)
    VALUES (p_plan, p_version, prev, plan_version_hash(p_plan, p_version, prev))
    ON CONFLICT DO NOTHING;
END
$$;

-- Seal a version when its transaction commits, after all its rows are in.
-- SECURITY DEFINER: the API's role has no INSERT on the seal table.
CREATE OR REPLACE FUNCTION seal_new_plan_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM allocation_plan_version
               WHERE allocation_plan_id = NEW.allocation_plan_id AND version_no = NEW.version_no) THEN
        PERFORM seal_plan_version(NEW.allocation_plan_id, NEW.version_no);
    END IF;
    RETURN NULL;
END
$$;

-- Named to sort after allocation_plan_version_hours (sql/011): triggers on
-- one row fire in name order, so the version is checked before it is sealed.
DROP TRIGGER IF EXISTS allocation_plan_version_seal ON allocation_plan_version;
CREATE CONSTRAINT TRIGGER allocation_plan_version_seal
    AFTER INSERT ON allocation_plan_version
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION seal_new_plan_version();

-- A sealed version takes no more rows. (An extra result with 0 taxis would
-- pass the hour totals; sql/012 only refuses UPDATE and DELETE.)
CREATE OR REPLACE FUNCTION refuse_insert_into_sealed_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM allocation_plan_version_seal
               WHERE allocation_plan_id = NEW.allocation_plan_id AND version_no = NEW.version_no) THEN
        RAISE EXCEPTION 'plan % version % is sealed (%); save a new version instead',
            NEW.allocation_plan_id, NEW.version_no, TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS allocation_result_sealed ON allocation_result;
CREATE TRIGGER allocation_result_sealed
    BEFORE INSERT ON allocation_result
    FOR EACH ROW EXECUTE FUNCTION refuse_insert_into_sealed_version();

DROP TRIGGER IF EXISTS allocation_plan_version_borough_sealed ON allocation_plan_version_borough;
CREATE TRIGGER allocation_plan_version_borough_sealed
    BEFORE INSERT ON allocation_plan_version_borough
    FOR EACH ROW EXECUTE FUNCTION refuse_insert_into_sealed_version();

-- Seals are history too: no UPDATE, and no DELETE except with the whole plan.
DROP TRIGGER IF EXISTS allocation_plan_version_seal_immutable ON allocation_plan_version_seal;
CREATE TRIGGER allocation_plan_version_seal_immutable
    BEFORE UPDATE OR DELETE ON allocation_plan_version_seal
    FOR EACH ROW EXECUTE FUNCTION refuse_plan_history_change();

-- Every version with what is wrong with its seal, or NULL if it is intact.
-- Runs with the caller's rights, so row-level security applies: through the
-- API an analyst checks their own plans and an admin everyone's.
CREATE OR REPLACE FUNCTION plan_seal_check(p_plan int DEFAULT NULL)
RETURNS TABLE (allocation_plan_id int, version_no int, hash text, problem text)
LANGUAGE sql STABLE AS $$
    SELECT v.allocation_plan_id, v.version_no, s.hash,
           CASE
               WHEN s.hash IS NULL THEN 'not sealed'
               WHEN s.prev_hash IS DISTINCT FROM
                    lag(s.hash) OVER (PARTITION BY v.allocation_plan_id ORDER BY v.version_no)
                   THEN 'does not follow the version before it'
               WHEN s.hash <> plan_version_hash(v.allocation_plan_id, v.version_no, s.prev_hash)
                   THEN 'changed after it was saved'
           END
    FROM allocation_plan_version v
    LEFT JOIN allocation_plan_version_seal s USING (allocation_plan_id, version_no)
    WHERE p_plan IS NULL OR v.allocation_plan_id = p_plan
$$;

-- Readable like the plan it belongs to (sql/016). No write policy and no
-- write grant: only the sealing trigger adds rows.
GRANT SELECT ON allocation_plan_version_seal TO ycq_read;
ALTER TABLE allocation_plan_version_seal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_read ON allocation_plan_version_seal;
CREATE POLICY plan_read ON allocation_plan_version_seal FOR SELECT
    USING (allocation_plan_id IN (SELECT allocation_plan_id FROM allocation_plan));

-- Versions saved before this file existed are sealed as they stand, oldest first.
DO $$
DECLARE
    v record;
BEGIN
    FOR v IN SELECT pv.allocation_plan_id, pv.version_no
             FROM allocation_plan_version pv
             LEFT JOIN allocation_plan_version_seal s USING (allocation_plan_id, version_no)
             WHERE s.hash IS NULL
             ORDER BY pv.allocation_plan_id, pv.version_no
    LOOP
        PERFORM seal_plan_version(v.allocation_plan_id, v.version_no);
    END LOOP;
END $$;
