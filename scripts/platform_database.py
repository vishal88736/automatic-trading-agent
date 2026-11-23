"""Apply platform migrations to the PostgreSQL database selected by the operator."""

from psycopg import Error

from backend.product.database import database_dsn, migrate, open_database


def main():
    try:
        with open_database(database_dsn()) as db:
            applied = migrate(db)
    except Error as exc:
        raise SystemExit(f"Platform migration failed ({type(exc).__name__})") from None
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    print("Applied " + ", ".join(applied) if applied else "Platform schema is up to date")


if __name__ == "__main__":
    main()
