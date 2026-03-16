"""
SQLAlchemy ORM models for ArrowMatch.

Schema version: 3
  - Challenge.parent_id: FK to parent challenge (null for root challenges)
  - Challenge.challenge_kind: 'normal' | 'tiebreak'
  - Tiebreak is a child challenge of the parent, linked to a new Match
  - Match.parent_match_id: FK to parent match (for tiebreak matches)
  - Removed submit_tiebreak endpoint — tiebreak uses submit_score on child match
"""
import enum
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Boolean, DateTime,
    ForeignKey, Text, Enum as SAEnum, Index
)
from sqlalchemy.orm import relationship, declarative_base

Base = declarative_base()

SCHEMA_VERSION = 4


class GenderEnum(str, enum.Enum):
    male   = "Male"
    female = "Female"


class AgeEnum(str, enum.Enum):
    under18  = "Under 18"
    age18_20 = "18–20"
    age21_49 = "21–49"
    age50plus = "50+"


class BowTypeEnum(str, enum.Enum):
    recurve  = "Recurve"
    compound = "Compound"
    barebow  = "Barebow"


class SkillLevelEnum(str, enum.Enum):
    beginner = "Beginner"
    skilled  = "Skilled"
    master   = "Master"


class MatchTypeEnum(str, enum.Enum):
    live      = "live"
    scheduled = "scheduled"


class DisciplineEnum(str, enum.Enum):
    """
    Archery discipline. Only 'target' is fully implemented.
    Others are stubs for future expansion.
    """
    target  = "target"
    indoor  = "indoor"   # stub
    field   = "field"    # stub
    three_d = "3d"       # stub
    clout   = "clout"    # stub
    flight  = "flight"   # stub


class ScoringEnum(str, enum.Enum):
    total = "total"
    sets  = "sets"


class ChallengeKindEnum(str, enum.Enum):
    normal   = "normal"    # standard challenge created by a user
    tiebreak = "tiebreak"  # auto-created child when parent match ends in a tie
    rematch  = "rematch"   # pending rematch — waiting for opponent acceptance


class MatchResultEnum(str, enum.Enum):
    win     = "win"
    loss    = "loss"
    draw    = "draw"
    pending = "pending"


class User(Base):
    __tablename__ = "users"

    id              = Column(String, primary_key=True)
    email           = Column(String, unique=True, nullable=True, index=True)
    hashed_password = Column(String, nullable=True)
    is_guest        = Column(Boolean, default=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    last_seen       = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile            = relationship("Profile", back_populates="user", uselist=False, cascade="all, delete-orphan")
    created_challenges = relationship("Challenge", foreign_keys="Challenge.creator_id",
                                      back_populates="creator", cascade="all, delete-orphan")
    match_participants = relationship("MatchParticipant", back_populates="user")


class Profile(Base):
    __tablename__ = "profiles"

    user_id     = Column(String, ForeignKey("users.id"), primary_key=True)
    name        = Column(String(64), nullable=False)
    gender      = Column(SAEnum(GenderEnum), nullable=False)
    age         = Column(SAEnum(AgeEnum), nullable=False)
    bow_type    = Column(SAEnum(BowTypeEnum), nullable=False)
    skill_level = Column(SAEnum(SkillLevelEnum), nullable=False)
    country     = Column(String(64), nullable=False)
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="profile")


class Challenge(Base):
    __tablename__ = "challenges"

    id              = Column(String, primary_key=True)
    creator_id      = Column(String, ForeignKey("users.id"), nullable=False, index=True)

    # Hierarchy: tiebreak challenges point to their parent
    parent_id       = Column(String, ForeignKey("challenges.id"), nullable=True, index=True)
    challenge_kind  = Column(SAEnum(ChallengeKindEnum), nullable=False,
                             default=ChallengeKindEnum.normal)

    match_type      = Column(SAEnum(MatchTypeEnum), nullable=False)
    discipline      = Column(SAEnum(DisciplineEnum), nullable=False,
                             default=DisciplineEnum.target)
    scoring         = Column(SAEnum(ScoringEnum), nullable=False)
    distance        = Column(String(8), nullable=False)
    arrow_count     = Column(Integer, nullable=True)
    invite_message  = Column(Text, nullable=True)
    deadline        = Column(DateTime, nullable=True)
    is_private      = Column(Boolean, default=False, index=True)
    is_active       = Column(Boolean, default=True, index=True)
    created_at      = Column(DateTime, default=datetime.utcnow, index=True)

    creator  = relationship("User", foreign_keys=[creator_id], back_populates="created_challenges")
    matches  = relationship("Match", back_populates="challenge")
    parent   = relationship("Challenge", remote_side="Challenge.id",
                            foreign_keys=[parent_id], backref="tiebreaks")

    __table_args__ = (
        Index("ix_challenges_active_public", "is_active", "is_private"),
    )


class Match(Base):
    __tablename__ = "matches"

    id              = Column(String, primary_key=True)
    challenge_id    = Column(String, ForeignKey("challenges.id", ondelete="SET NULL"),
                             nullable=True, index=True)
    # Links tiebreak match to parent match
    parent_match_id = Column(String, ForeignKey("matches.id", ondelete="SET NULL"),
                             nullable=True, index=True)
    status          = Column(String, default="waiting", index=True)  # waiting|active|complete
    created_at      = Column(DateTime, default=datetime.utcnow)
    completed_at    = Column(DateTime, nullable=True)

    # World Archery Gold round: user_id who shoots first in current set
    first_to_act    = Column(String, nullable=True)

    rematch_status      = Column(String, nullable=True)
    rematch_proposed_by = Column(String, nullable=True)

    challenge    = relationship("Challenge", back_populates="matches")
    participants = relationship("MatchParticipant", back_populates="match",
                                cascade="all, delete-orphan")
    tiebreak_matches = relationship(
        "Match",
        foreign_keys=[parent_match_id],
        back_populates="parent_match",
    )
    parent_match = relationship(
        "Match",
        foreign_keys=[parent_match_id],
        back_populates="tiebreak_matches",
        remote_side="Match.id",
        uselist=False,
    )


class MatchParticipant(Base):
    __tablename__ = "match_participants"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    match_id     = Column(String, ForeignKey("matches.id"), nullable=False, index=True)
    user_id      = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    is_creator   = Column(Boolean, default=False)
    is_bot       = Column(Boolean, default=False)
    final_score  = Column(Integer, nullable=True)
    result       = Column(SAEnum(MatchResultEnum), default=MatchResultEnum.pending)
    submitted_at = Column(DateTime, nullable=True)

    match        = relationship("Match", back_populates="participants")
    user         = relationship("User", back_populates="match_participants")
    arrow_scores = relationship("ArrowScore", back_populates="participant",
                                cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_mp_match_user", "match_id", "user_id"),
    )


class ArrowScore(Base):
    __tablename__ = "arrow_scores"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    participant_id = Column(Integer, ForeignKey("match_participants.id"),
                            nullable=False, index=True)
    arrow_index    = Column(Integer, nullable=False)  # 0-based global position
    value          = Column(Integer, nullable=False)  # 0–10
    set_number     = Column(Integer, nullable=True)   # non-null for set-system

    participant = relationship("MatchParticipant", back_populates="arrow_scores")

    __table_args__ = (
        Index("ix_arrows_participant_set", "participant_id", "set_number"),
    )


class SchemaVersion(Base):
    """Single-row table. If stored version != SCHEMA_VERSION the DB is recreated."""
    __tablename__ = "schema_version"

    id      = Column(Integer, primary_key=True, default=1)
    version = Column(Integer, nullable=False, default=SCHEMA_VERSION)
