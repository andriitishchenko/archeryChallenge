"""
Tiebreak logic for total-score mode.

When both players submit equal totals the server:
  1. Creates a child Challenge (kind=tiebreak, arrow_count=1) + Match
  2. Pushes tiebreak_started to both players
  3. Resolves the child match when both submit (repeated until one wins)
  4. Propagates win/loss back to the parent match
"""
import asyncio
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session, joinedload

from models.models import (
    Challenge, ChallengeKindEnum, DisciplineEnum, Match,
    MatchParticipant, MatchResultEnum, MatchTypeEnum, Profile, ScoringEnum,
)
from ws.manager import manager


def get_tiebreak_match(parent_match_id: str, db: Session) -> Optional[Match]:
    """Return the active or most-recent tiebreak child match for a parent match."""
    return (
        db.query(Match)
        .join(Challenge, Match.challenge_id == Challenge.id)
        .filter(
            Match.parent_match_id == parent_match_id,
            Challenge.challenge_kind == ChallengeKindEnum.tiebreak,
        )
        .order_by(Match.created_at.desc())
        .first()
    )


def create_tiebreak_match(parent_match: Match, db: Session) -> Match:
    """
    Create a child tiebreak Challenge + Match with the same two participants.
    The parent match stays active; winner is determined by the child result.
    """
    parent_ch = parent_match.challenge

    tb_ch = Challenge(
        id             = str(uuid.uuid4()),
        creator_id     = parent_ch.creator_id if parent_ch else parent_match.participants[0].user_id,
        parent_id      = parent_ch.id if parent_ch else None,
        challenge_kind = ChallengeKindEnum.tiebreak,
        match_type     = parent_ch.match_type if parent_ch else MatchTypeEnum.live,
        discipline     = parent_ch.discipline if parent_ch else DisciplineEnum.target,
        scoring        = ScoringEnum.total,
        distance       = parent_ch.distance if parent_ch else "30m",
        arrow_count    = 1,   # sudden-death: one arrow each
        is_private     = True,
        is_active      = True,
    )
    db.add(tb_ch)
    db.flush()

    tb_match = Match(
        id              = str(uuid.uuid4()),
        challenge_id    = tb_ch.id,
        parent_match_id = parent_match.id,
        status          = "active",
        first_to_act    = parent_match.first_to_act,
    )
    db.add(tb_match)
    db.flush()

    for p in parent_match.participants:
        db.add(MatchParticipant(
            match_id   = tb_match.id,
            user_id    = p.user_id,
            is_creator = p.is_creator,
            is_bot     = p.is_bot,
        ))
    db.commit()

    user_ids = [p.user_id for p in parent_match.participants if not p.is_bot]
    manager.register_match_participants(tb_match.id, user_ids)

    return tb_match


def notify_tiebreak_started(parent_match: Match, tb_match: Match, db: Session) -> None:
    """Push tiebreak_started to both players via /ws/user."""
    tb_ch = tb_match.challenge
    for p in parent_match.participants:
        if p.is_bot:
            continue
        from services.match import get_opponent, get_profile_name
        opp = get_opponent(parent_match, p.user_id)
        opp_name = get_profile_name(opp.user_id, db) if opp else "Opponent"
        asyncio.create_task(manager.notify_user(p.user_id, {
            "type":            "tiebreak_started",
            "parent_match_id": parent_match.id,
            "match_id":        tb_match.id,
            "challenge_id":    tb_match.challenge_id,
            "challenge_kind":  "tiebreak",
            "arrow_count":     1,
            "scoring":         "total",
            "distance":        tb_ch.distance if tb_ch else "30m",
            "opponent_name":   opp_name,
        }))


def resolve_parent_from_tiebreak(tb_match: Match, db: Session) -> None:
    """
    After a tiebreak match completes, propagate win/loss to the parent match
    participants and mark the parent complete.
    """
    if not tb_match.parent_match_id:
        return

    parent_match = (
        db.query(Match)
        .options(joinedload(Match.participants))
        .filter(Match.id == tb_match.parent_match_id)
        .first()
    )
    if not parent_match or parent_match.status == "complete":
        return

    for tb_p in tb_match.participants:
        parent_p = next(
            (p for p in parent_match.participants if p.user_id == tb_p.user_id),
            None,
        )
        if parent_p:
            parent_p.result = tb_p.result

    parent_match.status       = "complete"
    parent_match.completed_at = datetime.utcnow()
    db.commit()

    # Notify both players using the parent match id
    for p in parent_match.participants:
        if not p.is_bot:
            asyncio.create_task(manager.notify_user(p.user_id, {
                "type":     "match_complete",
                "match_id": parent_match.id,
            }))
