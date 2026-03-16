"""
Profile endpoints:
  GET  /api/profile            — current user's profile
  PUT  /api/profile            — create or update profile
  GET  /api/profile/{user_id}  — public profile
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.deps import get_db, get_current_user
from models.models import User, Profile
from schemas.profile import ProfileRequest, ProfileResponse

router = APIRouter(prefix="/api/profile", tags=["profile"])


def _to_response(p: Profile) -> dict:
    return {
        "user_id":    p.user_id,
        "name":       p.name,
        "gender":     p.gender.value,
        "age":        p.age.value,
        "bow_type":   p.bow_type.value,
        "skill_level": p.skill_level.value,
        "country":    p.country,
        "updated_at": p.updated_at,
    }


@router.get("", response_model=ProfileResponse)
def get_my_profile(current_user: User = Depends(get_current_user)):
    if not current_user.profile:
        raise HTTPException(status_code=404, detail="Profile not set up yet")
    return _to_response(current_user.profile)


@router.put("", response_model=ProfileResponse)
def upsert_profile(
    req:          ProfileRequest,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    profile = current_user.profile
    if profile is None:
        profile = Profile(user_id=current_user.id)
        db.add(profile)

    profile.name        = req.name
    profile.gender      = req.gender
    profile.age         = req.age
    profile.bow_type    = req.bow_type
    profile.skill_level = req.skill_level
    profile.country     = req.country
    profile.updated_at  = datetime.utcnow()

    db.commit()
    db.refresh(profile)
    return _to_response(profile)


@router.get("/{user_id}", response_model=ProfileResponse)
def get_public_profile(user_id: str, db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == user_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return _to_response(profile)
