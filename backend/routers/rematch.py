"""
Rematch endpoints:
  POST /api/matches/{id}/rematch          — propose a rematch
  POST /api/matches/{id}/rematch/accept   — accept (tolerates original OR new match id)
  POST /api/matches/{id}/rematch/decline  — decline
"""
import asyncio
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from core.deps import get_db, get_current_user
from models.models import (
    Challenge, ChallengeKindEnum, Match, MatchParticipant,
    MatchTypeEnum, Profile, User,
)
from schemas.matches import RematchOut
from services.match import get_opponent, get_participant, load_match
from ws.manager import manager

router = APIRouter(prefix="/api/matches", tags=["rematch"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _find_waiting_rematch(original_match_id: str, user_id: str, db: Session) -> Optional[Match]:
    """
    Given an original completed match ID, find the waiting rematch match.
    Used when the client lost the new match ID (page reload / WS disconnect).
    """
    original = (
        db.query(Match)
        .options(joinedload(Match.participants))
        .filter(Match.id == original_match_id)
        .first()
    )
    if not original:
        return None
    participant_ids = {p.user_id for p in original.participants}
    if user_id not in participant_ids:
        return None

    candidates = (
        db.query(Match)
        .join(Challenge, Match.challenge_id == Challenge.id)
        .join(MatchParticipant, MatchParticipant.match_id == Match.id)
        .filter(
            Match.status             == "waiting",
            Challenge.challenge_kind == ChallengeKindEnum.rematch,
            MatchParticipant.user_id == user_id,
        )
        .options(joinedload(Match.participants), joinedload(Match.challenge))
        .order_by(Match.created_at.desc())
        .all()
    )
    for candidate in candidates:
        if {p.user_id for p in candidate.participants} == participant_ids:
            return candidate
    return None


def _resolve_rematch_match(match_id: str, user_id: str, db: Session) -> Match:
    """
    Load match and auto-resolve to the waiting rematch child if the caller
    passed the original completed match ID instead of the new one.
    Raises 400 if no pending rematch is found either way.
    """
    match = load_match(match_id, db)
    ch    = match.challenge
    if not ch or ch.challenge_kind != ChallengeKindEnum.rematch:
        waiting = _find_waiting_rematch(match_id, user_id, db)
        if waiting is None:
            raise HTTPException(status_code=400, detail="Not a pending rematch")
        return waiting
    return match


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/{match_id}/rematch", response_model=RematchOut)
async def propose_rematch(
    match_id:     str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    match = load_match(match_id, db)
    if match.status != "complete":
        raise HTTPException(status_code=400, detail="Match is not complete yet")

    me  = get_participant(match, current_user.id)
    opp = get_opponent(match, current_user.id)
    if not opp:
        raise HTTPException(status_code=400, detail="No opponent to rematch")
    if match.rematch_status == "proposed":
        raise HTTPException(status_code=400, detail="Rematch already proposed")

    ch = match.challenge
    if not ch:
        raise HTTPException(status_code=400, detail="Cannot rematch — original challenge config missing")

    new_ch_id = str(uuid.uuid4())
    db.add(Challenge(
        id             = new_ch_id,
        creator_id     = current_user.id,
        challenge_kind = ChallengeKindEnum.rematch,
        match_type     = MatchTypeEnum.live,
        discipline     = ch.discipline,
        scoring        = ch.scoring,
        distance       = ch.distance,
        arrow_count    = ch.arrow_count,
        is_private     = True,
        is_active      = True,
    ))
    db.flush()

    new_match_id = str(uuid.uuid4())
    db.add(Match(id=new_match_id, challenge_id=new_ch_id, status="waiting", first_to_act=current_user.id))
    db.flush()
    db.add(MatchParticipant(match_id=new_match_id, user_id=current_user.id, is_creator=True))
    db.add(MatchParticipant(match_id=new_match_id, user_id=opp.user_id,    is_creator=False))

    match.rematch_status      = "proposed"
    match.rematch_proposed_by = current_user.id
    db.commit()

    me_profile    = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    proposer_name = me_profile.name if me_profile else "Opponent"

    asyncio.create_task(manager.notify_user(opp.user_id, {
        "type":         "rematch_proposed",
        "match_id":     new_match_id,
        "challenge_id": new_ch_id,
        "proposed_by":  proposer_name,
        "scoring":      ch.scoring.value,
        "distance":     ch.distance,
        "arrow_count":  ch.arrow_count,
        "match_type":   ch.match_type.value,
    }))

    return RematchOut(status="proposed", new_match_id=new_match_id, new_challenge_id=new_ch_id)


@router.post("/{match_id}/rematch/accept", response_model=RematchOut)
async def accept_rematch(
    match_id:     str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    # Accepts either the new waiting rematch match ID or the original completed match ID
    match = _resolve_rematch_match(match_id, current_user.id, db)
    ch    = match.challenge
    match_id = match.id  # normalise to actual rematch match id

    if match.status != "waiting":
        raise HTTPException(status_code=400, detail="Rematch already accepted or cancelled")

    me  = get_participant(match, current_user.id)
    opp = get_opponent(match, current_user.id)
    if not opp:
        raise HTTPException(status_code=400, detail="No opponent in rematch")

    proposer_id  = opp.user_id
    match.status = "active"
    ch.is_active = False
    db.commit()

    manager.register_match_participants(match_id, [proposer_id, current_user.id])

    me_profile       = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    proposer_profile = db.query(Profile).filter(Profile.user_id == proposer_id).first()
    acceptor_name    = me_profile.name       if me_profile       else "Opponent"
    proposer_name    = proposer_profile.name if proposer_profile else "Opponent"

    payload = {
        "match_id":     match_id, "challenge_id": ch.id,
        "scoring":      ch.scoring.value,  "distance":    ch.distance,
        "arrow_count":  ch.arrow_count,    "match_type":  ch.match_type.value,
    }
    asyncio.create_task(manager.notify_user(proposer_id, {
        "type": "rematch_accepted", "opponent_name": acceptor_name, **payload,
    }))
    asyncio.create_task(manager.notify_user(current_user.id, {
        "type": "match_ready", "opponent_name": proposer_name, **payload,
    }))

    return RematchOut(
        status="accepted", new_match_id=match_id, new_challenge_id=ch.id,
        opponent_name=proposer_name, scoring=ch.scoring.value,
        distance=ch.distance, arrow_count=ch.arrow_count, match_type=ch.match_type.value,
    )


@router.post("/{match_id}/rematch/decline", response_model=RematchOut)
async def decline_rematch(
    match_id:     str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    match = _resolve_rematch_match(match_id, current_user.id, db)
    ch    = match.challenge

    if match.status != "waiting":
        raise HTTPException(status_code=400, detail="Rematch is not pending")

    me  = get_participant(match, current_user.id)
    opp = get_opponent(match, current_user.id)
    proposer_id = opp.user_id if opp else None

    me_profile    = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    decliner_name = me_profile.name if me_profile else "Opponent"

    db.delete(match)
    db.flush()
    db.delete(ch)
    db.commit()

    if proposer_id:
        asyncio.create_task(manager.notify_user(proposer_id, {
            "type": "rematch_declined", "match_id": match_id, "declined_by": decliner_name,
        }))
    return RematchOut(status="declined")
