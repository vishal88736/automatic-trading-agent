"""Apply platform migrations to the PostgreSQL database selected by the operator."""

import os

from psycopg import Error

from backend.product.database import DSN_ENV, migrate, open_database


def main():
    dsn = os.environ.get(DSN_ENV)
    if not dsn:
        raise SystemExit(f"Set {DSN_ENV} to the platform PostgreSQL connection string")
    try:
        with open_database(dsn) as db:
            applied = migrate(db)
    except Error as exc:
        raise SystemExit(f"Platform migration failed ({type(exc).__name__})") from None
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    print("Applied " + ", ".join(applied) if applied else "Platform schema is up to date")


if __name__ == "__main__":
    main()
