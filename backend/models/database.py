"""
Database engine, session factory, and schema-version-based recreation.

On startup:
  1. If the DB file does not contain a schema_version table → fresh DB, create all.
  2. If schema_version.version < SCHEMA_VERSION → drop everything and recreate.
  3. Otherwise → leave existing data intact.

No migration scripts; incompatible schema bumps recreate from scratch.
"""
import logging
import os

from sqlalchemy import create_engine, text, inspect
from sqlalchemy.orm import sessionmaker

from models.models import Base, SCHEMA_VERSION, SchemaVersion
from core.config import settings

log = logging.getLogger(__name__)

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in settings.DATABASE_URL else {},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _get_stored_version() -> int | None:
    """Return the stored schema version, or None if the table doesn't exist."""
    insp = inspect(engine)
    if "schema_version" not in insp.get_table_names():
        return None
    with engine.connect() as conn:
        row = conn.execute(text("SELECT version FROM schema_version LIMIT 1")).fetchone()
        return row[0] if row else None


def _drop_all_tables():
    """Drop all tables respecting FK constraints (SQLite pragma + standard DROP)."""
    if "sqlite" in settings.DATABASE_URL:
        with engine.connect() as conn:
            conn.execute(text("PRAGMA foreign_keys = OFF"))
            conn.commit()
    Base.metadata.drop_all(bind=engine)
    if "sqlite" in settings.DATABASE_URL:
        with engine.connect() as conn:
            conn.execute(text("PRAGMA foreign_keys = ON"))
            conn.commit()


def create_tables():
    """
    Ensure the DB schema matches SCHEMA_VERSION.
    Recreates from scratch if version mismatch is detected.
    """
    stored = _get_stored_version()

    if stored is None:
        log.info("No schema_version found — creating fresh database (v%d).", SCHEMA_VERSION)
        Base.metadata.create_all(bind=engine)
        _write_version()

    elif stored < SCHEMA_VERSION:
        log.warning(
            "Schema version mismatch (stored=%d, current=%d) — "
            "dropping all tables and recreating.",
            stored, SCHEMA_VERSION,
        )
        _drop_all_tables()
        Base.metadata.create_all(bind=engine)
        _write_version()

    else:
        log.info("Schema up-to-date (v%d).", stored)


def _write_version():
    """Insert or replace the schema version row."""
    with SessionLocal() as db:
        existing = db.query(SchemaVersion).first()
        if existing:
            existing.version = SCHEMA_VERSION
        else:
            db.add(SchemaVersion(id=1, version=SCHEMA_VERSION))
        db.commit()


def get_db():
    """FastAPI dependency: yields a DB session and closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
