"""Create the ArrowMatch schema or adopt a current schema-version database."""

from alembic import op
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from models.models import Base


revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA_VERSION = 5
TABLES = {
    "schema_version",
    "users",
    "profiles",
    "challenges",
    "matches",
    "match_participants",
    "arrow_scores",
    "password_reset_tokens",
}
ENUMS = {
    "genderenum": ("male", "female"),
    "ageenum": ("under18", "age18_20", "age21_49", "age50plus"),
    "bowtypeenum": ("recurve", "compound", "barebow"),
    "skilllevelenum": ("beginner", "skilled", "master"),
    "matchtypeenum": ("live", "scheduled"),
    "disciplineenum": ("target", "indoor", "field", "three_d", "clout", "flight"),
    "scoringenum": ("total", "sets"),
    "challengekindenum": ("normal", "tiebreak", "rematch"),
    "matchresultenum": ("win", "loss", "draw", "pending"),
}


def _enum(name: str):
    values = ENUMS[name]
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(*values, name=name, create_type=False)
    return sa.Enum(*values, name=name, native_enum=False)


def _adopt_current_schema() -> bool:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    application_tables = existing & TABLES
    if "schema_version" not in existing:
        if application_tables:
            raise RuntimeError(
                "Found application tables without schema_version; "
                "refusing to stamp or modify an unknown database."
            )
        return False

    row = bind.execute(sa.text("SELECT version FROM schema_version LIMIT 1")).first()
    if row is None or row[0] != SCHEMA_VERSION or TABLES - existing:
        raise RuntimeError(
            "Existing schema is not the current version 5 schema; "
            "back up and migrate it explicitly before adopting Alembic."
        )

    differences = compare_metadata(
        MigrationContext.configure(bind, opts={"compare_type": True}),
        Base.metadata,
    )
    if differences:
        raise RuntimeError(
            "Existing schema does not match the current application metadata; "
            "back up and migrate it explicitly before adopting Alembic."
        )
    return True


def upgrade() -> None:
    if _adopt_current_schema():
        return

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for name, values in ENUMS.items():
            postgresql.ENUM(*values, name=name).create(bind, checkfirst=True)

    op.create_table(
        "schema_version",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(sa.text("INSERT INTO schema_version (id, version) VALUES (1, 5)"))

    op.create_table(
        "users",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("hashed_password", sa.String(), nullable=True),
        sa.Column("is_guest", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("last_seen", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "profiles",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("gender", _enum("genderenum"), nullable=False),
        sa.Column("age", _enum("ageenum"), nullable=False),
        sa.Column("bow_type", _enum("bowtypeenum"), nullable=False),
        sa.Column("skill_level", _enum("skilllevelenum"), nullable=False),
        sa.Column("country", sa.String(length=64), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("user_id"),
    )

    op.create_table(
        "challenges",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("creator_id", sa.String(), nullable=False),
        sa.Column("parent_id", sa.String(), nullable=True),
        sa.Column("challenge_kind", _enum("challengekindenum"), nullable=False),
        sa.Column("match_type", _enum("matchtypeenum"), nullable=False),
        sa.Column("discipline", _enum("disciplineenum"), nullable=False),
        sa.Column("scoring", _enum("scoringenum"), nullable=False),
        sa.Column("distance", sa.String(length=8), nullable=False),
        sa.Column("arrow_count", sa.Integer(), nullable=True),
        sa.Column("invite_message", sa.Text(), nullable=True),
        sa.Column("deadline", sa.DateTime(), nullable=True),
        sa.Column("is_private", sa.Boolean(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["creator_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["challenges.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_challenges_is_private", "challenges", ["is_private"], unique=False)
    op.create_index("ix_challenges_is_active", "challenges", ["is_active"], unique=False)
    op.create_index("ix_challenges_created_at", "challenges", ["created_at"], unique=False)
    op.create_index("ix_challenges_parent_id", "challenges", ["parent_id"], unique=False)
    op.create_index("ix_challenges_active_public", "challenges", ["is_active", "is_private"], unique=False)
    op.create_index("ix_challenges_creator_id", "challenges", ["creator_id"], unique=False)

    op.create_table(
        "matches",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("challenge_id", sa.String(), nullable=True),
        sa.Column("parent_match_id", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("first_to_act", sa.String(), nullable=True),
        sa.Column("rematch_status", sa.String(), nullable=True),
        sa.Column("rematch_proposed_by", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["challenge_id"], ["challenges.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["parent_match_id"], ["matches.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_matches_parent_match_id", "matches", ["parent_match_id"], unique=False)
    op.create_index("ix_matches_status", "matches", ["status"], unique=False)
    op.create_index("ix_matches_challenge_id", "matches", ["challenge_id"], unique=False)

    op.create_table(
        "match_participants",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("match_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("is_creator", sa.Boolean(), nullable=True),
        sa.Column("is_bot", sa.Boolean(), nullable=True),
        sa.Column("final_score", sa.Integer(), nullable=True),
        sa.Column("result", _enum("matchresultenum"), nullable=True),
        sa.Column("submitted_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_match_participants_user_id", "match_participants", ["user_id"], unique=False)
    op.create_index("ix_match_participants_match_id", "match_participants", ["match_id"], unique=False)
    op.create_index("ix_mp_match_user", "match_participants", ["match_id", "user_id"], unique=False)

    op.create_table(
        "arrow_scores",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("participant_id", sa.Integer(), nullable=False),
        sa.Column("arrow_index", sa.Integer(), nullable=False),
        sa.Column("value", sa.Integer(), nullable=False),
        sa.Column("set_number", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["participant_id"], ["match_participants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_arrows_participant_set", "arrow_scores", ["participant_id", "set_number"], unique=False)
    op.create_index("ix_arrow_scores_participant_id", "arrow_scores", ["participant_id"], unique=False)

    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_password_reset_tokens_user_id", "password_reset_tokens", ["user_id"], unique=False)
    op.create_index("ix_password_reset_tokens_token_hash", "password_reset_tokens", ["token_hash"], unique=True)


def downgrade() -> None:
    raise RuntimeError("The initial ArrowMatch schema migration cannot be downgraded safely.")
