"""
Challenge endpoints:
  GET    /api/challenges              — list public open challenges (excludes own)
  POST   /api/challenges              — create a new challenge
  GET    /api/challenges/mine         — list my challenges
  GET    /api/challenges/{id}         — get single challenge (used for private links)
  DELETE /api/challenges/{id}         — delete my challenge
  POST   /api/challenges/{id}/join    — join a challenge (creates a Match)
"""
import asyncio
import uuid
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from core.deps import get_db, get_current_user
from models.models import (
    User, Challenge, Match, MatchParticipant,
    MatchTypeEnum, ScoringEnum
)
from ws.manager import manager

router = APIRouter(prefix="/api/challenges", tags=["challenges"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ChallengeCreate(BaseModel):
    match_type: MatchTypeEnum
    scoring: ScoringEnum
    distance: str
    arrow_count: Optional[int] = 18
    invite_message: Optional[str] = None
    deadline: Optional[datetime] = None


class ChallengeOut(BaseModel):
    id: str
    creator_id: str
    creator_name: str
    creator_gender: str
    creator_age: str
    creator_bow_type: str
    creator_skill_level: str
    creator_country: str
    match_type: str
    scoring: str
    distance: str
    arrow_count: Optional[int]
    invite_message: Optional[str]
    deadline: Optional[datetime]
    is_private: bool
    created_at: datetime

    class Config:
        from_attributes = True


class JoinResponse(BaseModel):
    match_id: str
    challenge_id: str
    message: str
    # Challenge fields needed by the client to render the match correctly
    scoring: str
    distance: str
    arrow_count: Optional[int]
    creator_name: str
    match_type: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=List[ChallengeOut])
def list_challenges(
    skill: Optional[List[str]] = Query(None),
    gender: Optional[List[str]] = Query(None),
    bow: Optional[List[str]] = Query(None),
    dist: Optional[List[str]] = Query(None),
    country: Optional[str] = Query(None),
    limit: int = Query(50, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    List active public challenges.
    Own challenges are always excluded so users don't see their own cards.
    """
    q = (
        db.query(Challenge)
        .options(joinedload(Challenge.creator).joinedload(User.profile))
        .filter(
            Challenge.is_active == True,
            Challenge.is_private == False,
            Challenge.creator_id != current_user.id,   # exclude own challenges
        )
        .order_by(Challenge.created_at.desc())
    )

    if skill:
        from models.models import Profile
        q = (q.join(User, Challenge.creator_id == User.id)
               .join(Profile)
               .filter(Profile.skill_level.in_(skill)))

    if dist:
        q = q.filter(Challenge.distance.in_(dist))

    challenges = q.limit(limit).all()

    result = []
    for ch in challenges:
        p = ch.creator.profile
        if not p:
            continue
        if gender and p.gender.value not in gender:
            continue
        if bow and p.bow_type.value not in bow:
            continue
        if country and p.country != country:
            continue
        result.append(_challenge_to_out(ch))
    return result


@router.get("/mine", response_model=List[ChallengeOut])
def list_my_challenges(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenges = (
        db.query(Challenge)
        .options(joinedload(Challenge.creator).joinedload(User.profile))
        .filter(Challenge.creator_id == current_user.id)
        .order_by(Challenge.created_at.desc())
        .all()
    )
    return [_challenge_to_out(ch) for ch in challenges if ch.creator.profile]


@router.get("/{challenge_id}", response_model=ChallengeOut)
def get_challenge(challenge_id: str, db: Session = Depends(get_db)):
    """
    Fetch a single challenge by ID.
    Used for private challenge link resolution — no auth required so
    a recipient can load the challenge before they have an account.
    """
    ch = _load_challenge(challenge_id, db)
    return _challenge_to_out(ch)


@router.post("", response_model=ChallengeOut)
async def create_challenge(
    req: ChallengeCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not current_user.profile:
        raise HTTPException(status_code=400, detail="Complete your profile before creating challenges")

    _validate_challenge(req)

    challenge = Challenge(
        id=str(uuid.uuid4()),
        creator_id=current_user.id,
        match_type=req.match_type,
        scoring=req.scoring,
        distance=req.distance,
        arrow_count=req.arrow_count if req.scoring == ScoringEnum.total else None,
        invite_message=req.invite_message,
        deadline=req.deadline,
        is_private=(req.match_type == MatchTypeEnum.private),
        is_active=True,
    )
    db.add(challenge)
    db.commit()
    db.refresh(challenge)

    ch = _load_challenge(challenge.id, db)
    out = _challenge_to_out(ch)

    # Broadcast to all clients watching the challenge list feed.
    # Private challenges are never shown in the public list.
    if not challenge.is_private:
        asyncio.ensure_future(manager.broadcast_challenge_event({
            "type": "new_challenge",
            "challenge": out,
        }))

    return out


@router.delete("/{challenge_id}", status_code=204)
async def delete_challenge(
    challenge_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = _load_challenge(challenge_id, db)
    if ch.creator_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your challenge")

    # Refuse deletion if any linked match is still active with both participants joined
    for m in ch.matches:
        if m.status != "complete" and len(m.participants) >= 2:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete — a match is in progress. Wait for it to complete or forfeit first."
            )

    # Null out challenge_id on linked matches before deleting the challenge.
    # This satisfies the FK constraint while preserving match history rows.
    for match in ch.matches:
        match.challenge_id = None
    db.flush()

    ch_id = ch.id
    was_public = not ch.is_private

    db.delete(ch)
    db.commit()

    # Notify all clients watching the public list
    if was_public:
        asyncio.ensure_future(manager.broadcast_challenge_event({
            "type": "challenge_removed",
            "challenge_id": ch_id,
        }))


@router.post("/{challenge_id}/join", response_model=JoinResponse)
async def join_challenge(
    challenge_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not current_user.profile:
        raise HTTPException(status_code=400, detail="Complete your profile first")

    ch = _load_challenge(challenge_id, db)
    if not ch.is_active:
        raise HTTPException(status_code=400, detail="Challenge is no longer active")
    if ch.creator_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot join your own challenge")

    # Create match with both participants
    match_id = str(uuid.uuid4())
    match = Match(id=match_id, challenge_id=ch.id, status="active")
    db.add(match)

    db.add(MatchParticipant(match_id=match_id, user_id=ch.creator_id, is_creator=True))
    db.add(MatchParticipant(match_id=match_id, user_id=current_user.id, is_creator=False))

    # Live/async challenges become inactive after first join.
    # Private challenges stay active so the creator can reshare the link.
    became_inactive = False
    if ch.match_type in (MatchTypeEnum.live, MatchTypeEnum.async_):
        ch.is_active = False
        became_inactive = not ch.is_private

    db.commit()

    # Broadcast removal to challenge list feed if challenge is now inactive
    if became_inactive:
        asyncio.ensure_future(manager.broadcast_challenge_event({
            "type": "challenge_removed",
            "challenge_id": ch.id,
        }))

    # Push opponent_joined to the creator's waiting WS (registered via
    # /ws/challenge/{id}/wait) so they receive the real match_id and can
    # transition from the waiting state to the active match screen.
    joiner_name = current_user.profile.name if current_user.profile else "Opponent"
    creator_id  = ch.creator_id
    await manager.notify_user(creator_id, {
        "type": "opponent_joined",
        "match_id": match_id,
        "opponent_name": joiner_name,
    })

    return JoinResponse(
        match_id=match_id,
        challenge_id=ch.id,
        message="Joined successfully",
        scoring=ch.scoring.value,
        distance=ch.distance,
        arrow_count=ch.arrow_count,
        creator_name=ch.creator.profile.name if ch.creator.profile else "Opponent",
        match_type=ch.match_type.value,
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_challenge(challenge_id: str, db: Session) -> Challenge:
    ch = (
        db.query(Challenge)
        .options(joinedload(Challenge.creator).joinedload(User.profile))
        .filter(Challenge.id == challenge_id)
        .first()
    )
    if not ch:
        raise HTTPException(status_code=404, detail="Challenge not found")
    return ch


def _validate_challenge(req: ChallengeCreate):
    valid_distances = {"18m", "25m", "30m", "50m", "70m", "90m"}
    if req.distance not in valid_distances:
        raise HTTPException(status_code=400, detail=f"Distance must be one of {valid_distances}")
    if req.scoring == ScoringEnum.total and (req.arrow_count is None or not (3 <= req.arrow_count <= 360)):
        raise HTTPException(status_code=400, detail="Arrow count must be 3–360 for total scoring")
    # Deadline required for async/scheduled but optional for private (invite link challenges)
    if req.match_type in (MatchTypeEnum.async_, MatchTypeEnum.scheduled):
        if not req.deadline:
            raise HTTPException(status_code=400, detail="Deadline required for async/scheduled challenges")
    if req.invite_message and len(req.invite_message) > 200:
        raise HTTPException(status_code=400, detail="Invite message max 200 characters")


def _challenge_to_out(ch: Challenge) -> dict:
    p = ch.creator.profile
    return {
        "id": ch.id,
        "creator_id": ch.creator_id,
        "creator_name": p.name,
        "creator_gender": p.gender.value,
        "creator_age": p.age.value,
        "creator_bow_type": p.bow_type.value,
        "creator_skill_level": p.skill_level.value,
        "creator_country": p.country,
        "match_type": ch.match_type.value,
        "scoring": ch.scoring.value,
        "distance": ch.distance,
        "arrow_count": ch.arrow_count,
        "invite_message": ch.invite_message,
        "deadline": ch.deadline,
        "is_private": ch.is_private,
        "created_at": ch.created_at,
    }
