"""
Challenge endpoints:
  GET    /api/challenges                — list public open challenges (excludes own)
  POST   /api/challenges                — create a new challenge
  GET    /api/challenges/mine           — list my challenges
  GET    /api/challenges/{id}           — get single challenge (private link)
  DELETE /api/challenges/{id}           — delete my challenge
  POST   /api/challenges/{id}/join      — join a challenge (creates a Match)
"""
import asyncio
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import exists

from core.deps import get_db, get_current_user
from models.models import (
    Challenge, DisciplineEnum, Match, MatchParticipant,
    MatchTypeEnum, ScoringEnum, User,
)
from schemas.challenges import ChallengeCreate, ChallengeOut, JoinResponse
from services.challenges import challenge_to_out
from ws.manager import manager

router = APIRouter(prefix="/api/challenges", tags=["challenges"])


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


def _validate_challenge(req: ChallengeCreate) -> None:
    valid_distances = {"18m", "25m", "30m", "50m", "70m", "90m"}
    if req.distance not in valid_distances:
        raise HTTPException(status_code=400, detail=f"Distance must be one of {valid_distances}")
    if req.scoring == ScoringEnum.total and (req.arrow_count is None or not (3 <= req.arrow_count <= 360)):
        raise HTTPException(status_code=400, detail="Arrow count must be 3–360 for total scoring")
    if req.match_type == MatchTypeEnum.scheduled and not req.deadline:
        raise HTTPException(status_code=400, detail="Deadline required for scheduled challenges")
    if req.invite_message and len(req.invite_message) > 200:
        raise HTTPException(status_code=400, detail="Invite message max 200 characters")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=List[ChallengeOut])
def list_challenges(
    skill:   Optional[List[str]] = Query(None),
    gender:  Optional[List[str]] = Query(None),
    bow:     Optional[List[str]] = Query(None),
    dist:    Optional[List[str]] = Query(None),
    country: Optional[str]       = Query(None),
    limit:   int                 = Query(50, le=100),
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    from models.models import Profile
    q = (
        db.query(Challenge)
        .options(joinedload(Challenge.creator).joinedload(User.profile))
        .filter(
            Challenge.is_active  == True,
            Challenge.is_private == False,
            Challenge.creator_id != current_user.id,
        )
        .order_by(Challenge.created_at.desc())
    )
    if skill:
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
        result.append(challenge_to_out(ch))
    return result


@router.get("/mine", response_model=List[ChallengeOut])
def list_my_challenges(
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    challenges = (
        db.query(Challenge)
        .options(joinedload(Challenge.creator).joinedload(User.profile))
        .filter(
            Challenge.creator_id == current_user.id,
            (Challenge.is_active == True) | (
                db.query(Match.id)
                .filter(
                    Match.challenge_id == Challenge.id,
                    Match.status != "complete",
                )
                .correlate(Challenge)
                .exists()
            ),
        )
        .order_by(Challenge.created_at.desc())
        .all()
    )
    return [challenge_to_out(ch) for ch in challenges if ch.creator.profile]


@router.get("/{challenge_id}", response_model=ChallengeOut)
def get_challenge(challenge_id: str, db: Session = Depends(get_db)):
    """No auth required — used for private-link resolution."""
    return challenge_to_out(_load_challenge(challenge_id, db))


@router.post("", response_model=ChallengeOut)
async def create_challenge(
    req:          ChallengeCreate,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    if not current_user.profile:
        raise HTTPException(status_code=400, detail="Complete your profile before creating challenges")
    _validate_challenge(req)

    challenge = Challenge(
        id             = str(uuid.uuid4()),
        creator_id     = current_user.id,
        match_type     = req.match_type,
        discipline     = req.discipline,
        scoring        = req.scoring,
        distance       = req.distance,
        arrow_count    = req.arrow_count if req.scoring == ScoringEnum.total else None,
        invite_message = req.invite_message,
        deadline       = req.deadline,
        is_private     = req.is_private,
        is_active      = True,
    )
    db.add(challenge)
    db.commit()
    db.refresh(challenge)

    ch  = _load_challenge(challenge.id, db)
    out = challenge_to_out(ch)

    if not challenge.is_private:
        asyncio.create_task(manager.broadcast_challenge_event({
            "type": "new_challenge", "challenge": out,
        }))
    return out


@router.delete("/{challenge_id}", status_code=204)
async def delete_challenge(
    challenge_id: str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    ch = _load_challenge(challenge_id, db)
    if ch.creator_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your challenge")
    for m in ch.matches:
        if m.status != "complete" and len(m.participants) >= 2:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete — a match is in progress. Forfeit first.",
            )
    for match in ch.matches:
        match.challenge_id = None
    db.flush()

    ch_id      = ch.id
    was_public = not ch.is_private
    db.delete(ch)
    db.commit()

    if was_public:
        asyncio.create_task(manager.broadcast_challenge_event({
            "type": "challenge_removed", "challenge_id": ch_id,
        }))


@router.post("/{challenge_id}/join", response_model=JoinResponse)
async def join_challenge(
    challenge_id: str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    if not current_user.profile:
        raise HTTPException(status_code=400, detail="Complete your profile first")

    ch = _load_challenge(challenge_id, db)

    if ch.discipline != DisciplineEnum.target:
        raise HTTPException(status_code=501, detail=f"Discipline '{ch.discipline.value}' is not yet implemented")
    if not ch.is_active:
        raise HTTPException(status_code=400, detail="Challenge is no longer active")
    if ch.creator_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot join your own challenge")
    if ch.deadline and ch.deadline < datetime.utcnow():
        ch.is_active = False
        db.commit()
        raise HTTPException(status_code=400, detail="Challenge deadline has passed")

    match_id = str(uuid.uuid4())
    db.add(Match(
        id           = match_id,
        challenge_id = ch.id,
        status       = "active",
        first_to_act = ch.creator_id,
    ))
    db.add(MatchParticipant(match_id=match_id, user_id=ch.creator_id,      is_creator=True))
    db.add(MatchParticipant(match_id=match_id, user_id=current_user.id,    is_creator=False))

    became_inactive = False
    if ch.match_type in (MatchTypeEnum.live, MatchTypeEnum.scheduled):
        ch.is_active    = False
        became_inactive = not ch.is_private
    db.commit()

    manager.register_match_participants(match_id, [ch.creator_id, current_user.id])

    if became_inactive:
        asyncio.create_task(manager.broadcast_challenge_event({
            "type": "challenge_removed", "challenge_id": ch.id,
        }))

    joiner_name = current_user.profile.name if current_user.profile else "Opponent"
    asyncio.create_task(manager.notify_user(ch.creator_id, {
        "type":          "opponent_joined",
        "match_id":      match_id,
        "opponent_name": joiner_name,
        "challenge_id":  ch.id,
    }))

    return JoinResponse(
        match_id     = match_id,
        challenge_id = ch.id,
        message      = "Joined successfully",
        scoring      = ch.scoring.value,
        distance     = ch.distance,
        arrow_count  = ch.arrow_count,
        creator_name = ch.creator.profile.name if ch.creator.profile else "Opponent",
        match_type   = ch.match_type.value,
        discipline   = ch.discipline.value,
    )
