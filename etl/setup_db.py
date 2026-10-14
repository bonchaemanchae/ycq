"""Apply every sql/NNN_*.sql file in order. Safe to run again."""
from common import SQL, pg_connect


def main() -> None:
    with pg_connect(autocommit=True) as conn:
        for path in sorted(SQL.glob("[0-9][0-9][0-9]_*.sql")):
            print(f"applying {path.name}")
            conn.execute(path.read_text(encoding="utf-8"))
    print("schema ready")


if __name__ == "__main__":
    main()
