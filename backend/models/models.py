"""
SQLAlchemy ORM models for ArrowMatch.
"""
import enum
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, Boolean, DateTime,
    ForeignKey, Text, Enum as SAEnum
)
from sqlalchemy.orm import relationship, declarative_base

Base = declarative_base()


class GenderEnum(str, enum.Enum):
    male = "Male"
    female = "Female"


class AgeEnum(str, enum.Enum):
    under18 = "Under 18"
    age18_20 = "18–20"
    age21_49 = "21–49"
    age50plus = "50+"


class BowTypeEnum(str, enum.Enum):
    recurve = "Recurve"
    compound = "Compound"
    barebow = "Barebow"


class SkillLevelEnum(str, enum.Enum):
    beginner = "Beginner"
    skilled = "Skilled"
    master = "Master"


class MatchTypeEnum(str, enum.Enum):
    live = "live"
    async_ = "async"
    scheduled = "scheduled"
    private = "private"


class ScoringEnum(str, enum.Enum):
    total = "total"
    sets = "sets"


class MatchResultEnum(str, enum.Enum):
    win = "win"
    loss = "loss"
    draw = "draw"
    pending = "pending"


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True)          # server-issued hash, e.g. AM-xxx-xxx
    email = Column(String, unique=True, nullable=True, index=True)
    hashed_password = Column(String, nullable=True)
    is_guest = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_seen = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile", back_populates="user", uselist=False, cascade="all, delete-orphan")
    created_challenges = relationship("Challenge", back_populates="creator", cascade="all, delete-orphan")
    match_participants = relationship("MatchParticipant", back_populates="user")


class Profile(Base):
    __tablename__ = "profiles"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    name = Column(String(64), nullable=False)
    gender = Column(SAEnum(GenderEnum), nullable=False)
    age = Column(SAEnum(AgeEnum), nullable=False)
    bow_type = Column(SAEnum(BowTypeEnum), nullable=False)
    skill_level = Column(SAEnum(SkillLevelEnum), nullable=False)
    country = Column(String(64), nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="profile")


class Challenge(Base):
    __tablename__ = "challenges"

    id = Column(String, primary_key=True)
    creator_id = Column(String, ForeignKey("users.id"), nullable=False)
    match_type = Column(SAEnum(MatchTypeEnum), nullable=False)
    scoring = Column(SAEnum(ScoringEnum), nullable=False)
    distance = Column(String(8), nullable=False)          # e.g. "30m"
    arrow_count = Column(Integer, nullable=True)           # for total scoring
    invite_message = Column(Text, nullable=True)
    deadline = Column(DateTime, nullable=True)
    is_private = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    creator = relationship("User", back_populates="created_challenges")
    matches = relationship("Match", back_populates="challenge")


class Match(Base):
    __tablename__ = "matches"

    id = Column(String, primary_key=True)
    challenge_id = Column(String, ForeignKey("challenges.id", ondelete="SET NULL"), nullable=True)
    status = Column(String, default="waiting")            # waiting, active, complete
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    # Rematch state: None | "proposed" | "accepted" | "declined"
    rematch_status = Column(String, nullable=True)
    # user_id of who proposed the rematch
    rematch_proposed_by = Column(String, nullable=True)

    challenge = relationship("Challenge", back_populates="matches")
    participants = relationship("MatchParticipant", back_populates="match", cascade="all, delete-orphan")


class MatchParticipant(Base):
    __tablename__ = "match_participants"

    id = Column(Integer, primary_key=True, autoincrement=True)
    match_id = Column(String, ForeignKey("matches.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    is_creator = Column(Boolean, default=False)
    is_bot = Column(Boolean, default=False)
    final_score = Column(Integer, nullable=True)
    result = Column(SAEnum(MatchResultEnum), default=MatchResultEnum.pending)
    submitted_at = Column(DateTime, nullable=True)

    match = relationship("Match", back_populates="participants")
    user = relationship("User", back_populates="match_participants")
    arrow_scores = relationship("ArrowScore", back_populates="participant", cascade="all, delete-orphan")


class ArrowScore(Base):
    __tablename__ = "arrow_scores"

    id = Column(Integer, primary_key=True, autoincrement=True)
    participant_id = Column(Integer, ForeignKey("match_participants.id"), nullable=False)
    arrow_index = Column(Integer, nullable=False)      # 0-based position
    value = Column(Integer, nullable=False)            # 0–10
    set_number = Column(Integer, nullable=True)        # for set system

    participant = relationship("MatchParticipant", back_populates="arrow_scores")
