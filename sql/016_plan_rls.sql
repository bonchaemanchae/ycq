-- Row-level security on saved plans: PostgreSQL itself decides whose plans a
-- query can see or change, so a query that forgets "WHERE owner_user_id = ..."
-- still only reaches the caller's plans.
--
-- Who is calling: the API sets app.user_id on its connection for each
-- request, from the login token (api/auth.py current_user), and clears it
-- when the connection goes back to the pool (api/db.py). Unset means no one:
-- no plan is visible.
--
--   read a plan     its owner, or an active admin (the Users section counts
--                   everyone's plans, and deleting a user reports theirs)
--   change a plan   its owner only
--
-- Versions, their boroughs and results follow their plan. The owner role
-- (loader, tests, psql) is the tables' owner and bypasses these rules; the
-- API's login (sql/015) never does. This guards against a bug in the API's
-- queries; the API still checks the owner in every query itself
-- (api/planner.py). Safe to run again.

CREATE OR REPLACE FUNCTION app_user_id() RETURNS int
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::int
$$;

CREATE OR REPLACE FUNCTION app_user_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM app_user u
        JOIN app_user_role USING (user_id)
        JOIN app_role r USING (role_id)
        WHERE u.user_id = app_user_id() AND u.is_active AND r.name = 'admin')
$$;

ALTER TABLE allocation_plan ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_read ON allocation_plan;
CREATE POLICY plan_read ON allocation_plan FOR SELECT
    USING (owner_user_id = app_user_id() OR app_user_is_admin());
DROP POLICY IF EXISTS plan_write ON allocation_plan;
CREATE POLICY plan_write ON allocation_plan FOR ALL
    USING (owner_user_id = app_user_id())
    WITH CHECK (owner_user_id = app_user_id());

-- A plan's versions, version boroughs and results: readable when the plan is
-- (the subquery is itself filtered by plan_read), changeable when the caller
-- owns the plan.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['allocation_plan_version', 'allocation_plan_version_borough', 'allocation_result']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS plan_read ON %I', t);
        EXECUTE format(
            'CREATE POLICY plan_read ON %I FOR SELECT
                 USING (allocation_plan_id IN (SELECT allocation_plan_id FROM allocation_plan))', t);
        EXECUTE format('DROP POLICY IF EXISTS plan_write ON %I', t);
        EXECUTE format(
            'CREATE POLICY plan_write ON %I FOR ALL
                 USING (allocation_plan_id IN (SELECT allocation_plan_id FROM allocation_plan
                                               WHERE owner_user_id = app_user_id()))
                 WITH CHECK (allocation_plan_id IN (SELECT allocation_plan_id FROM allocation_plan
                                                    WHERE owner_user_id = app_user_id()))', t);
    END LOOP;
END $$;

-- A view normally reads its tables with its creator's rights, which would
-- skip the policies above. security_invoker makes it use the caller's.
ALTER VIEW v_plan_summary SET (security_invoker = true);
