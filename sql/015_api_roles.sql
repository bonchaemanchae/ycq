-- Least privilege for the API (master plan 10.3). The API used to connect as
-- the database owner, a superuser that could drop any table. Now it logs in
-- as its own role, a member of ycq_write:
--
--   ycq_read    SELECT on every table and view, nothing else
--   ycq_write   ycq_read, plus changing users and plans: the only tables the
--               API writes (api/auth.py, api/users.py, api/planner.py)
--
-- Neither group role can log in. etl/setup_db.py creates the API's login
-- (POSTGRES_APP_USER, default ycq_app) with the password from .env. The
-- loader, the tests and psql keep using the owner (POSTGRES_USER), because
-- imports, summary rebuilds and schema changes need it.
--
-- Roles belong to the whole server and grants to one database, so this also
-- runs on the test database. Safe to run again.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ycq_read') THEN
        CREATE ROLE ycq_read NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ycq_write') THEN
        CREATE ROLE ycq_write NOLOGIN;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO ycq_read', current_database());
END $$;

GRANT ycq_read TO ycq_write;

-- Read: every table, view and materialised view, and those the owner adds
-- later (a new month's trip partition, say).
GRANT USAGE ON SCHEMA public TO ycq_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ycq_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ycq_read;

-- Write: accounts and roles (login, the Users section) and saved plans. The
-- plan triggers (sql/006, 011, 012) still check every write, and
-- ON DELETE CASCADE still removes a deleted user's plans.
GRANT INSERT, UPDATE, DELETE ON
    app_user, app_user_role,
    allocation_plan, allocation_plan_version, allocation_plan_version_borough, allocation_result
TO ycq_write;
GRANT USAGE ON SEQUENCE app_user_user_id_seq, allocation_plan_allocation_plan_id_seq TO ycq_write;
