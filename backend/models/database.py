"""
Database engine and session factory.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models.models import Base
from core.config import settings

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in settings.DATABASE_URL else {},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def create_tables():
    """Create all tables if they don't exist, then apply incremental migrations."""
    Base.metadata.create_all(bind=engine)
    _migrate(engine)


def _migrate(engine):
    """Apply additive schema migrations safe to run on every startup."""
    with engine.connect() as conn:
        # Add rematch columns to matches table if not present (SQLite compatible)
        existing = [row[1] for row in conn.execute(
            __import__("sqlalchemy").text("PRAGMA table_info(matches)")
        )]
        migrations = [
            ("rematch_status",      "ALTER TABLE matches ADD COLUMN rematch_status VARCHAR"),
            ("rematch_proposed_by", "ALTER TABLE matches ADD COLUMN rematch_proposed_by VARCHAR"),
        ]
        for col, sql in migrations:
            if col not in existing:
                conn.execute(__import__("sqlalchemy").text(sql))
        conn.commit()


def get_db():
    """FastAPI dependency: yields a DB session and closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
