"""Apply every sql/NNN_*.sql file in order, then create the API's login role.
Safe to run again."""
import os
import sys

from psycopg import sql

from common import SQL, pg_connect


def ensure_app_role(conn, user: str, password: str) -> None:
    """The API's PostgreSQL login: a member of ycq_write (sql/015) and
    nothing more. Created on the first run; its password follows .env."""
    if user == conn.info.user:
        sys.exit(f"POSTGRES_APP_USER must not be the owner {user!r}: the API gets a limited role")
    exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (user,)).fetchone()
    conn.execute(sql.SQL("{} ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {}").format(
        sql.SQL("ALTER" if exists else "CREATE"), sql.Identifier(user), sql.Literal(password)))
    conn.execute(sql.SQL("GRANT ycq_write TO {}").format(sql.Identifier(user)))


def main() -> None:
    with pg_connect(autocommit=True) as conn:
        for path in sorted(SQL.glob("[0-9][0-9][0-9]_*.sql")):
            print(f"applying {path.name}")
            conn.execute(path.read_text(encoding="utf-8"))
        user = os.getenv("POSTGRES_APP_USER", "ycq_app")
        if password := os.getenv("POSTGRES_APP_PASSWORD"):
            ensure_app_role(conn, user, password)
            print(f"API login {user!r}: member of ycq_write")
        else:
            print("POSTGRES_APP_PASSWORD not set: the API's login role was not created")
    print("schema ready")


if __name__ == "__main__":
    main()
