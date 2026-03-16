"""
Match query helpers shared across routers.
All DB reads for Match, MatchParticipant, and Profile go through here.
"""
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from models.models import (
    Match, MatchParticipant, Profile, Challenge,
    ArrowScore, ChallengeKindEnum,
)
from schemas.matches import MatchOut, MatchParticipantOut


# ── Basic loaders ─────────────────────────────────────────────────────────────

def load_match(match_id: str, db: Session) -> Match:
    """Load a Match with participants and challenge eagerly. Raises 404 if missing."""
    match = (
        db.query(Match)
        .options(
            joinedload(Match.participants),
            joinedload(Match.challenge),
        )
        .filter(Match.id == match_id)
        .first()
    )
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    return match


def get_participant(match: Match, user_id: str) -> MatchParticipant:
    """Return the caller's MatchParticipant. Raises 403 if not in match."""
    p = next((p for p in match.participants if p.user_id == user_id), None)
    if not p:
        raise HTTPException(status_code=403, detail="You are not part of this match")
    return p


def get_opponent(match: Match, user_id: str) -> Optional[MatchParticipant]:
    """Return the opponent MatchParticipant, or None for single-player matches."""
    return next((p for p in match.participants if p.user_id != user_id), None)


def get_profile_name(user_id: str, db: Session) -> str:
    """Return the display name for a user, falling back to 'Opponent'."""
    profile = db.query(Profile).filter(Profile.user_id == user_id).first()
    return profile.name if profile else "Opponent"


# ── Set-system helpers ────────────────────────────────────────────────────────

def count_set_points(participant: MatchParticipant, match_id: str, db: Session) -> int:
    """
    Derive accumulated set-points by comparing per-set ArrowScore totals.
    Idempotent — safe to call multiple times in one request.
    """
    match = (
        db.query(Match)
        .options(joinedload(Match.participants))
        .filter(Match.id == match_id)
        .first()
    )
    if not match:
        return 0

    opp = next((p for p in match.participants if p.id != participant.id), None)
    if not opp:
        return 0

    def _set_totals(pid: int):
        return {
            r.set_number: r.total
            for r in db.query(
                ArrowScore.set_number,
                func.sum(ArrowScore.value).label("total"),
            )
            .filter(
                ArrowScore.participant_id == pid,
                ArrowScore.set_number.isnot(None),
            )
            .group_by(ArrowScore.set_number)
            .all()
        }

    my_map  = _set_totals(participant.id)
    opp_map = _set_totals(opp.id)

    pts = 0
    for sn, mt in my_map.items():
        if sn not in opp_map:
            continue   # opponent hasn't submitted this set yet
        ot = opp_map[sn]
        if mt > ot:
            pts += 2
        elif mt == ot:
            pts += 1
    return pts


# ── Serialisation ─────────────────────────────────────────────────────────────

def match_to_out(match: Match, db: Session) -> MatchOut:
    participants_out = []
    for p in match.participants:
        profile = db.query(Profile).filter(Profile.user_id == p.user_id).first()
        participants_out.append(MatchParticipantOut(
            user_id      = p.user_id,
            name         = profile.name if profile else "Unknown",
            is_creator   = p.is_creator,
            final_score  = p.final_score,
            result       = p.result.value,
            submitted_at = p.submitted_at,
        ))
    return MatchOut(
        id           = match.id,
        challenge_id = match.challenge_id,
        status       = match.status,
        participants = participants_out,
        created_at   = match.created_at,
        completed_at = match.completed_at,
    )


# ── Judge-status builder ──────────────────────────────────────────────────────

def build_judge_status(
    match: Match,
    me: MatchParticipant,
    opp: Optional[MatchParticipant],
    scoring: str,
    current_set: int,
    tiebreak_req: bool,
    opp_name: str,
    my_user_id: str,
) -> str:
    from models.models import MatchResultEnum

    if match.status == "complete":
        if me.result == MatchResultEnum.win:
            return "Match complete — You win! 🏆"
        elif me.result == MatchResultEnum.loss:
            return f"Match complete — {opp_name} wins."
        else:
            return "Match complete — Draw!"

    if tiebreak_req:
        return "Scores tied — sudden-death! Shoot one arrow each. Highest wins."

    if scoring == "sets":
        my_pts  = me.final_score  or 0
        opp_pts = opp.final_score or 0 if opp else 0
        first   = match.first_to_act
        if me.submitted_at and (opp is None or opp.submitted_at is None):
            return f"Set {current_set}: waiting for {opp_name} to shoot…"
        if first == my_user_id:
            return f"Set {current_set} [{my_pts}:{opp_pts}] — You shoot first."
        return f"Set {current_set} [{my_pts}:{opp_pts}] — {opp_name} shoots first."

    # Total mode
    if me.submitted_at is None:
        return "Shoot your arrows, then submit your score."
    if opp and opp.submitted_at is None:
        return f"Score submitted — waiting for {opp_name}…"
    return "Calculating result…"
