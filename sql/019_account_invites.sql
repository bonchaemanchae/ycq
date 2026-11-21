-- Invitations instead of admin-set passwords. An admin creates an account
-- with an email, a name and a role but no password; the new user sets their
-- own password through a one-time link. The admin never knows it.
--
--   app_user.password_hash  NULL while the account is invited (not set up yet)
--   account_invite          one row per link sent. Only a SHA-256 hash of the
--                           link's token is stored, so a copy of this table
--                           can't be turned into working links. A link works
--                           once (used_at), until it expires (expires_at), and
--                           stops working when a newer link replaces it or the
--                           account is disabled (revoked_at).
--
-- Accounts are disabled, never deleted, from the app: a disabled user can't
-- log in, but their saved plans (and the hash chain over them, sql/017) and
-- saved views are kept, so the API no longer needs to delete users at all.
-- Safe to run again.

ALTER TABLE app_user ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS account_invite (
    account_invite_id  serial PRIMARY KEY,
    user_id            int NOT NULL REFERENCES app_user ON DELETE CASCADE,
    token_sha256       text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    created_by         int REFERENCES app_user ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    used_at            timestamptz,
    revoked_at         timestamptz,
    CHECK (expires_at > created_at),
    CHECK (used_at IS NULL OR revoked_at IS NULL)
);

-- At most one open link per account: sending a new one must revoke the old.
CREATE UNIQUE INDEX IF NOT EXISTS account_invite_one_open
    ON account_invite (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- The API reads and writes invitations (sql/015 grants ycq_read SELECT on
-- every table already). It may deactivate accounts but no longer delete them.
GRANT INSERT, UPDATE ON account_invite TO ycq_write;
GRANT USAGE ON SEQUENCE account_invite_account_invite_id_seq TO ycq_write;
REVOKE DELETE ON app_user, app_user_role FROM ycq_write;
