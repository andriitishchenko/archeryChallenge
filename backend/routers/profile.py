"""
Profile endpoints:
  GET  /api/profile          — get current user's profile
  PUT  /api/profile          — update current user's profile
  GET  /api/profile/{user_id} — get any user's public profile
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from core.deps import get_db, get_current_user
from models.models import User, Profile, GenderEnum, AgeEnum, BowTypeEnum, SkillLevelEnum

router = APIRouter(prefix="/api/profile", tags=["profile"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProfileRequest(BaseModel):
    name: str
    gender: GenderEnum
    age: AgeEnum
    bow_type: BowTypeEnum
    skill_level: SkillLevelEnum
    country: str

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 64:
            raise ValueError("Name must be 1–64 characters")
        return v

    @field_validator("country")
    @classmethod
    def country_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 64:
            raise ValueError("Country required")
        return v


class ProfileResponse(BaseModel):
    user_id: str
    name: str
    gender: str
    age: str
    bow_type: str
    skill_level: str
    country: str
    updated_at: datetime

    class Config:
        from_attributes = True


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=ProfileResponse)
def get_my_profile(current_user: User = Depends(get_current_user)):
    if not current_user.profile:
        raise HTTPException(status_code=404, detail="Profile not set up yet")
    return _profile_to_response(current_user.profile)


@router.put("", response_model=ProfileResponse)
def upsert_profile(
    req: ProfileRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or update the authenticated user's profile."""
    profile = current_user.profile
    if profile is None:
        profile = Profile(user_id=current_user.id)
        db.add(profile)

    profile.name = req.name
    profile.gender = req.gender
    profile.age = req.age
    profile.bow_type = req.bow_type
    profile.skill_level = req.skill_level
    profile.country = req.country
    profile.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(profile)
    return _profile_to_response(profile)


@router.get("/{user_id}", response_model=ProfileResponse)
def get_public_profile(user_id: str, db: Session = Depends(get_db)):
    """Public profile — used when displaying opponent info."""
    profile = db.query(Profile).filter(Profile.user_id == user_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return _profile_to_response(profile)


def _profile_to_response(p: Profile) -> dict:
    return {
        "user_id": p.user_id,
        "name": p.name,
        "gender": p.gender.value,
        "age": p.age.value,
        "bow_type": p.bow_type.value,
        "skill_level": p.skill_level.value,
        "country": p.country,
        "updated_at": p.updated_at,
    }
