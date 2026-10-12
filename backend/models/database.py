"""Database engine, session factory, and startup schema verification."""
import logging
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from core.config import settings
from models.models import Base, SCHEMA_VERSION


log = logging.getLogger(__name__)
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def verify_schema() -> None:
    """Require an explicitly migrated database that matches this application."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "schema_version" not in tables or "alembic_version" not in tables:
        raise RuntimeError("Database is not initialized; run `alembic upgrade head` before startup.")

    with engine.connect() as conn:
        schema_row = conn.execute(text("SELECT version FROM schema_version LIMIT 1")).first()
        applied_revisions = {
            row[0] for row in conn.execute(text("SELECT version_num FROM alembic_version")).all()
        }
        schema_differences = compare_metadata(
            MigrationContext.configure(conn, opts={"compare_type": True}),
            Base.metadata,
        )

    if schema_row is None or schema_row[0] != SCHEMA_VERSION:
        actual = schema_row[0] if schema_row else "missing"
        raise RuntimeError(
            f"Database schema version {actual} does not match this application (version {SCHEMA_VERSION}); "
            "apply a reviewed migration before startup."
        )

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config(str(_ALEMBIC_INI))
    expected_revisions = set(ScriptDirectory.from_config(config).get_heads())
    if applied_revisions != expected_revisions:
        raise RuntimeError(
            "Database migrations are not at the application head; run `alembic upgrade head` before startup."
        )
    if schema_differences:
        raise RuntimeError(
            "Database structure does not match this application; apply a reviewed migration before startup."
        )
    log.info("Database schema and migrations are current (%s).", ",".join(sorted(expected_revisions)))


def get_db():
    """FastAPI dependency: yields a DB session and closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
