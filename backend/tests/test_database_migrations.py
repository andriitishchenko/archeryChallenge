from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from core.config import settings
from models import database
from models.models import Base


BACKEND_DIR = Path(__file__).resolve().parents[1]


class DatabaseMigrationTests(TestCase):
    def _upgrade(self, database_path: Path) -> None:
        config = Config(str(BACKEND_DIR / "alembic.ini"))
        with patch.object(settings, "DATABASE_URL", f"sqlite:///{database_path}"):
            command.upgrade(config, "head")

    def test_fresh_database_is_initialized_by_the_baseline_migration(self):
        with TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "fresh.db"
            self._upgrade(database_path)

            engine = create_engine(f"sqlite:///{database_path}")
            try:
                tables = set(inspect(engine).get_table_names())
                self.assertTrue(set(Base.metadata.tables).issubset(tables))
                with engine.connect() as connection:
                    schema_version = connection.execute(text("SELECT version FROM schema_version")).scalar_one()
                    revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
                self.assertEqual(schema_version, 5)
                self.assertEqual(revision, "0001_initial_schema")
                with patch.object(database, "engine", engine):
                    database.verify_schema()
            finally:
                engine.dispose()

    def test_current_schema_is_adopted_and_existing_rows_are_preserved(self):
        with TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "current.db"
            engine = create_engine(f"sqlite:///{database_path}")
            try:
                Base.metadata.create_all(engine)
                with engine.begin() as connection:
                    connection.execute(Base.metadata.tables["schema_version"].insert().values(id=1, version=5))
                    connection.execute(Base.metadata.tables["users"].insert().values(
                        id="preserved-user", is_guest=True,
                    ))
            finally:
                engine.dispose()

            self._upgrade(database_path)

            engine = create_engine(f"sqlite:///{database_path}")
            try:
                with engine.connect() as connection:
                    self.assertEqual(
                        connection.execute(text("SELECT id FROM users")).scalar_one(),
                        "preserved-user",
                    )
                    revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
                self.assertEqual(revision, "0001_initial_schema")
            finally:
                engine.dispose()

    def test_incompatible_schema_is_rejected_without_changing_existing_rows(self):
        with TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "old.db"
            engine = create_engine(f"sqlite:///{database_path}")
            try:
                Base.metadata.create_all(engine)
                with engine.begin() as connection:
                    connection.execute(Base.metadata.tables["schema_version"].insert().values(id=1, version=4))
                    connection.execute(Base.metadata.tables["users"].insert().values(
                        id="preserved-user", is_guest=True,
                    ))
            finally:
                engine.dispose()

            with self.assertRaises(RuntimeError):
                self._upgrade(database_path)

            engine = create_engine(f"sqlite:///{database_path}")
            try:
                with engine.connect() as connection:
                    version = connection.execute(text("SELECT version FROM schema_version")).scalar_one()
                    user_id = connection.execute(text("SELECT id FROM users")).scalar_one()
                self.assertEqual(version, 4)
                self.assertEqual(user_id, "preserved-user")
            finally:
                engine.dispose()

    def test_runtime_verification_rejects_schema_drift(self):
        with TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "drift.db"
            self._upgrade(database_path)
            engine = create_engine(f"sqlite:///{database_path}")
            try:
                with engine.begin() as connection:
                    connection.execute(text("DROP TABLE arrow_scores"))
                with patch.object(database, "engine", engine):
                    with self.assertRaisesRegex(RuntimeError, "structure does not match"):
                        database.verify_schema()
            finally:
                engine.dispose()
