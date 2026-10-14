-- Users and roles (many-to-many). Accounts are created in advance; no sign-up.

CREATE TABLE IF NOT EXISTS app_role (
    role_id    smallserial PRIMARY KEY,
    name       text NOT NULL UNIQUE
);

INSERT INTO app_role (name) VALUES ('analyst'), ('admin')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_user (
    user_id        serial PRIMARY KEY,
    email          text NOT NULL,
    display_name   text NOT NULL,
    password_hash  text NOT NULL,          -- Argon2
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_uq ON app_user (lower(email));

CREATE TABLE IF NOT EXISTS app_user_role (
    user_id  int NOT NULL REFERENCES app_user ON DELETE CASCADE,
    role_id  smallint NOT NULL REFERENCES app_role,
    PRIMARY KEY (user_id, role_id)
);
