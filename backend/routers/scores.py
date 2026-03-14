"""
Score endpoints:
  POST /api/matches/{match_id}/set     — submit one set of 3 arrows (set-system mode)
                                         server resolves set when both players submit;
                                         returns set winner + cumulative set scores
  POST /api/matches/{match_id}/score   — submit all arrows (total-score mode)
                                         server resolves match when both submit;
                                         handles tiebreak sudden-death round
  GET  /api/matches/{match_id}         — poll match state (opponent score, result)
  GET  /api/history                    — my match history
  GET  /api/ranking                    — global leaderboard
  GET  /api/achievements               — my achievement badges
"""
from datetime import datetime
from typing import List, Optional, Dict
import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from core.deps import get_db, get_current_user
from models.models import (
    User, Match, MatchParticipant, ArrowScore,
    MatchResultEnum, Profile, Challenge, ScoringEnum,
    MatchTypeEnum, Challenge
)
from ws.manager import manager

router = APIRouter(prefix="/api", tags=["scores"])

# ── Schemas ───────────────────────────────────────────────────────────────────

class ArrowScoreItem(BaseModel):
    arrow_index: int
    value: int
    set_number: Optional[int] = None

    @field_validator("value")
    @classmethod
    def valid_score(cls, v: int) -> int:
        if not (0 <= v <= 10):
            raise ValueError("Arrow score must be 0–10")
        return v

    @field_validator("arrow_index")
    @classmethod
    def valid_index(cls, v: int) -> int:
        if v < 0 or v > 359:
            raise ValueError("Arrow index out of range")
        return v

class SetSubmission(BaseModel):
    set_number: int      # 1-based set index; use 0 for tiebreak sudden-death
    arrows: List[int]    # exactly 3 values (or 1 for sudden-death)

    @field_validator("arrows")
    @classmethod
    def valid_arrows(cls, v: List[int]) -> List[int]:
        if not (1 <= len(v) <= 3):
            raise ValueError("Each set must have 1–3 arrows")
        for score in v:
            if not (0 <= score <= 10):
                raise ValueError("Arrow score must be 0–10")
        return v

class SetResult(BaseModel):
    set_number: int
    both_submitted: bool
    my_set_total: int
    opp_set_total: Optional[int]    # None until opponent submits
    set_winner: Optional[str]       # "me" | "opponent" | "draw"
    my_set_points: int              # accumulated set-system points
    opp_set_points: int
    match_complete: bool
    match_winner: Optional[str]     # "me" | "opponent" | None
    tiebreak_required: bool         # True if sudden-death arrow needed

class ScoreSubmission(BaseModel):
    arrows: List[ArrowScoreItem]

class MatchStatusOut(BaseModel):
    id: str
    status: str                         # "active" | "waiting_opponent" | "complete"
    scoring: str
    my_score: Optional[int]
    opp_score: Optional[int]            # None until opponent submits (total mode)
    opp_submitted: bool
    result: Optional[str]               # "win" | "loss" | "draw" | None
    tiebreak_required: bool
    # Set system fields
    my_set_points: int
    opp_set_points: int
    current_set: int
    sets: List[Dict]                    # [{set_number, my_total, opp_total, winner}]

class MatchParticipantOut(BaseModel):
    user_id: str
    name: str
    is_creator: bool
    final_score: Optional[int]
    result: str
    submitted_at: Optional[datetime]

class MatchOut(BaseModel):
    id: str
    challenge_id: Optional[str]
    status: str
    participants: List[MatchParticipantOut]
    created_at: datetime
    completed_at: Optional[datetime]

class HistoryItem(BaseModel):
    match_id: str
    opponent_name: str
    distance: str
    scoring: str
    my_score: Optional[int]
    opponent_score: Optional[int]
    result: str
    date: datetime

class RankingEntry(BaseModel):
    rank: int
    user_id: str
    name: str
    bow_type: str
    wins: int
    matches_played: int
    avg_score: float

class AchievementItem(BaseModel):
    id: str
    icon: str
    label: str
    earned: bool

# ── Set-system endpoint ───────────────────────────────────────────────────────

@router.post("/matches/{match_id}/set", response_model=SetResult)
def submit_set(
    match_id: str,
    sub: SetSubmission,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Submit one set of 3 arrows (or 1 arrow for sudden-death tiebreak).
    Server waits until both players submit the same set_number, then resolves it.
    Returns the set result; if match_complete=True the match is done.
    """
    match = _load_match(match_id, db)
    challenge = match.challenge

    if match.status == "complete":
        raise HTTPException(status_code=400, detail="Match already completed")

    me = _get_participant(match, current_user.id)

    # Persist this set's arrows (replace if re-submitting)
    db.query(ArrowScore).filter(
        ArrowScore.participant_id == me.id,
        ArrowScore.set_number == sub.set_number,
    ).delete()

    for idx, val in enumerate(sub.arrows):
        db.add(ArrowScore(
            participant_id=me.id,
            arrow_index=(sub.set_number * 10 + idx),   # unique global index
            value=val,
            set_number=sub.set_number,
        ))
    db.flush()

    my_total = sum(sub.arrows)

    # Compute my accumulated set points so far (for response)
    my_set_pts  = _count_set_points(me.id, match_id, db)
    opp         = _get_opponent(match, current_user.id)
    opp_set_pts = _count_set_points(opp.id, match_id, db) if opp else 0

    # Check if opponent has submitted this same set
    opp_set_arrows = (
        db.query(ArrowScore)
        .filter(
            ArrowScore.participant_id == opp.id,
            ArrowScore.set_number == sub.set_number,
        )
        .all()
        if opp else []
    )

    if not opp_set_arrows:
        # Opponent hasn't submitted yet — just save and return pending
        db.commit()
        return SetResult(
            set_number=sub.set_number,
            both_submitted=False,
            my_set_total=my_total,
            opp_set_total=None,
            set_winner=None,
            my_set_points=my_set_pts,
            opp_set_points=opp_set_pts,
            match_complete=False,
            match_winner=None,
            tiebreak_required=False,
        )

    # Both submitted — resolve this set
    opp_total = sum(a.value for a in opp_set_arrows)

    # Assign set points (2 for win, 1 each for draw)
    if my_total > opp_total:
        set_winner = "me"
        me_pts_gained  = 2
        opp_pts_gained = 0
    elif opp_total > my_total:
        set_winner = "opponent"
        me_pts_gained  = 0
        opp_pts_gained = 2
    else:
        set_winner = "draw"
        me_pts_gained  = 1
        opp_pts_gained = 1

    # Store set result on participants as running score
    # We encode set points as fractional final_score update; track in metadata
    me.final_score  = (me.final_score  or 0) + me_pts_gained
    opp.final_score = (opp.final_score or 0) + opp_pts_gained

    new_my_pts  = me.final_score
    new_opp_pts = opp.final_score

    # Win condition: first to 6 set-points wins
    match_complete = new_my_pts >= 6 or new_opp_pts >= 6
    match_winner   = None
    tiebreak       = False

    if match_complete:
        if new_my_pts > new_opp_pts:
            match_winner = "me"
            me.result  = MatchResultEnum.win
            opp.result = MatchResultEnum.loss
        elif new_opp_pts > new_my_pts:
            match_winner = "opponent"
            me.result  = MatchResultEnum.loss
            opp.result = MatchResultEnum.win
        else:
            # Equal set-points at 6:6 — sudden death tiebreak (set_number=0)
            tiebreak = True
            match_complete = False  # not truly done yet

        if not tiebreak:
            match.status = "complete"
            match.completed_at = datetime.utcnow()

    db.commit()

    return SetResult(
        set_number=sub.set_number,
        both_submitted=True,
        my_set_total=my_total,
        opp_set_total=opp_total,
        set_winner=set_winner,
        my_set_points=new_my_pts,
        opp_set_points=new_opp_pts,
        match_complete=match_complete,
        match_winner=match_winner,
        tiebreak_required=tiebreak,
    )

# ── Total-score endpoint ──────────────────────────────────────────────────────

@router.post("/matches/{match_id}/score", status_code=200)
def submit_score(
    match_id: str,
    submission: ScoreSubmission,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Submit all arrows for total-score mode.
    Returns immediately with submitted=True.
    Client should then poll GET /api/matches/{match_id} until status='complete'.
    If both players tie, the match stays active and both must submit a sudden-death
    single arrow via POST /api/matches/{match_id}/set with set_number=0.
    """
    match = _load_match(match_id, db)
    if match.status == "complete":
        raise HTTPException(status_code=400, detail="Match already completed")

    me = _get_participant(match, current_user.id)

    challenge = match.challenge
    if challenge:
        expected = challenge.arrow_count or len(submission.arrows)
        if challenge.scoring == ScoringEnum.total and len(submission.arrows) != expected:
            raise HTTPException(
                status_code=400,
                detail=f"Expected {expected} arrows, got {len(submission.arrows)}"
            )

    # Replace previous submission
    db.query(ArrowScore).filter(ArrowScore.participant_id == me.id).delete()
    for a in submission.arrows:
        db.add(ArrowScore(
            participant_id=me.id,
            arrow_index=a.arrow_index,
            value=a.value,
        ))

    me.final_score   = sum(a.value for a in submission.arrows)
    me.submitted_at  = datetime.utcnow()
    db.commit()

    # Resolve match if all human participants submitted
    human = [p for p in match.participants if not p.is_bot]
    all_submitted = all(p.submitted_at is not None for p in human)

    if all_submitted:
        _resolve_total_match(match, db)

    db.refresh(match)

    # Detect tiebreak: both players submitted with equal scores (match stays active)
    human = [p for p in match.participants if not p.is_bot]
    all_submitted_now = all(p.submitted_at is not None for p in human)
    tiebreak = (
        all_submitted_now
        and match.status != "complete"
        and len(human) == 2
        and human[0].final_score is not None
        and human[0].final_score == human[1].final_score
    )

    return {
        "status": "submitted",
        "match_complete": match.status == "complete",
        "tiebreak_required": tiebreak,
    }

# ── Match status polling ──────────────────────────────────────────────────────

@router.get("/matches/{match_id}/status", response_model=MatchStatusOut)
def get_match_status(
    match_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Poll match state. Used by clients after submitting to wait for opponent.
    Returns opponent score and result once available.
    """
    match = _load_match(match_id, db)
    me  = _get_participant(match, current_user.id)
    opp = _get_opponent(match, current_user.id)

    challenge = match.challenge
    scoring   = challenge.scoring.value if challenge else "total"

    opp_submitted = opp.submitted_at is not None if opp else False
    result        = me.result.value if me.result != MatchResultEnum.pending else None

    # Check for tiebreak condition (total mode: both submitted, equal score)
    tiebreak_req = False
    if match.status == "active" and opp_submitted and me.submitted_at:
        if me.final_score == opp.final_score:
            tiebreak_req = True

    # Build per-set history for set-system mode
    sets_out = []
    if scoring == "sets":
        all_my_sets = (
            db.query(ArrowScore.set_number,
                     func.sum(ArrowScore.value).label("total"))
            .filter(ArrowScore.participant_id == me.id)
            .group_by(ArrowScore.set_number)
            .all()
        )
        all_opp_sets = (
            db.query(ArrowScore.set_number,
                     func.sum(ArrowScore.value).label("total"))
            .filter(ArrowScore.participant_id == opp.id)
            .group_by(ArrowScore.set_number)
            .all()
            if opp else []
        )
        my_set_map  = {r.set_number: r.total for r in all_my_sets}
        opp_set_map = {r.set_number: r.total for r in all_opp_sets}
        all_set_nums = sorted(set(my_set_map.keys()) | set(opp_set_map.keys()))
        for sn in all_set_nums:
            mt = my_set_map.get(sn)
            ot = opp_set_map.get(sn)
            winner = None
            if mt is not None and ot is not None:
                winner = "me" if mt > ot else ("opponent" if ot > mt else "draw")
            sets_out.append({"set_number": sn, "my_total": mt, "opp_total": ot, "winner": winner})

    return MatchStatusOut(
        id=match.id,
        status=match.status if not tiebreak_req else "tiebreak",
        scoring=scoring,
        my_score=me.final_score,
        opp_score=opp.final_score if (opp_submitted or match.status == "complete") else None,
        opp_submitted=opp_submitted,
        result=result,
        tiebreak_required=tiebreak_req,
        my_set_points=me.final_score or 0,
        opp_set_points=opp.final_score or 0,
        current_set=len(sets_out) + 1,
        sets=sets_out,
    )

@router.get("/matches/{match_id}", response_model=MatchOut)
def get_match(
    match_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    match = _load_match(match_id, db)
    if not any(p.user_id == current_user.id for p in match.participants):
        raise HTTPException(status_code=403, detail="Not your match")
    return _match_to_out(match, db)

# ── History & ranking ─────────────────────────────────────────────────────────

@router.get("/history", response_model=List[HistoryItem])
def get_history(
    limit: int = 30,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    participants = (
        db.query(MatchParticipant)
        .filter(
            MatchParticipant.user_id == current_user.id,
            MatchParticipant.result != MatchResultEnum.pending,
        )
        .order_by(MatchParticipant.submitted_at.desc())
        .limit(limit)
        .all()
    )

    result = []
    for p in participants:
        match = _load_match(p.match_id, db)
        opp   = _get_opponent(match, current_user.id)
        if not opp:
            continue
        opp_profile = db.query(Profile).filter(Profile.user_id == opp.user_id).first()
        ch          = match.challenge
        result.append(HistoryItem(
            match_id=match.id,
            opponent_name=opp_profile.name if opp_profile else "Unknown",
            distance=ch.distance if ch else "—",
            scoring=ch.scoring.value if ch else "total",
            my_score=p.final_score,
            opponent_score=opp.final_score,
            result=p.result.value,
            date=p.submitted_at or match.created_at,
        ))
    return result

@router.get("/ranking", response_model=List[RankingEntry])
def get_ranking(
    bow_type: Optional[str] = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    participants = (
        db.query(MatchParticipant)
        .filter(
            MatchParticipant.result != MatchResultEnum.pending,
            MatchParticipant.is_bot == False,
        )
        .all()
    )

    user_stats: dict = {}
    for p in participants:
        uid = p.user_id
        if uid not in user_stats:
            user_stats[uid] = {"wins": 0, "matches": 0, "total_score": 0}
        user_stats[uid]["matches"] += 1
        if p.result == MatchResultEnum.win:
            user_stats[uid]["wins"] += 1
        if p.final_score:
            user_stats[uid]["total_score"] += p.final_score

    sorted_users = sorted(user_stats.items(), key=lambda x: x[1]["wins"], reverse=True)[:limit]

    result = []
    for rank, (uid, stats) in enumerate(sorted_users, 1):
        profile = db.query(Profile).filter(Profile.user_id == uid).first()
        if not profile:
            continue
        if bow_type and profile.bow_type.value != bow_type:
            continue
        avg = stats["total_score"] / stats["matches"] if stats["matches"] > 0 else 0
        result.append(RankingEntry(
            rank=rank,
            user_id=uid,
            name=profile.name,
            bow_type=profile.bow_type.value,
            wins=stats["wins"],
            matches_played=stats["matches"],
            avg_score=round(avg, 1),
        ))
    return result

@router.get("/achievements", response_model=List[AchievementItem])
def get_achievements(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    participants = (
        db.query(MatchParticipant)
        .filter(
            MatchParticipant.user_id == current_user.id,
            MatchParticipant.result != MatchResultEnum.pending,
        )
        .order_by(MatchParticipant.submitted_at.desc())
        .all()
    )

    total_matches = len(participants)
    win_streak = 0
    for p in participants:
        if p.result == MatchResultEnum.win:
            win_streak += 1
        else:
            break

    badge_defs = [
        ("streak_5",    "🔥", "5 Win Streak",   win_streak    >= 5),
        ("streak_10",   "⚡", "10 Win Streak",  win_streak    >= 10),
        ("streak_25",   "👑", "25 Win Streak",  win_streak    >= 25),
        ("matches_10",  "🎯", "10 Matches",     total_matches >= 10),
        ("matches_50",  "🏹", "50 Matches",     total_matches >= 50),
        ("matches_100", "🌟", "100 Matches",    total_matches >= 100),
    ]

    return [
        AchievementItem(id=bid, icon=icon, label=label, earned=earned)
        for bid, icon, label, earned in badge_defs
    ]

# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_match(match_id: str, db: Session) -> Match:
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

def _get_participant(match: Match, user_id: str) -> MatchParticipant:
    p = next((p for p in match.participants if p.user_id == user_id), None)
    if not p:
        raise HTTPException(status_code=403, detail="You are not part of this match")
    return p

def _get_opponent(match: Match, user_id: str) -> Optional[MatchParticipant]:
    return next((p for p in match.participants if p.user_id != user_id), None)

def _count_set_points(participant_id: str, match_id: str, db: Session) -> int:
    """Sum the participant's final_score which stores accumulated set points."""
    p = db.query(MatchParticipant).filter(MatchParticipant.id == participant_id).first()
    return p.final_score or 0

def _resolve_total_match(match: Match, db: Session):
    """Determine win/loss/draw for total-score mode. Tie stays active for sudden-death."""
    human = [p for p in match.participants if not p.is_bot]
    if len(human) < 2:
        return

    scores = {p.id: (p.final_score or 0) for p in human}
    score_vals = list(scores.values())

    # Tie: keep match active so clients know to do sudden-death
    if len(set(score_vals)) == 1:
        # Don't mark complete — clients will poll and see tiebreak_required=True
        return

    max_score = max(score_vals)
    for p in human:
        if scores[p.id] == max_score:
            p.result = MatchResultEnum.win
        else:
            p.result = MatchResultEnum.loss

    match.status = "complete"
    match.completed_at = datetime.utcnow()
    db.commit()

def _match_to_out(match: Match, db: Session) -> MatchOut:
    participants_out = []
    for p in match.participants:
        profile = db.query(Profile).filter(Profile.user_id == p.user_id).first()
        participants_out.append(MatchParticipantOut(
            user_id=p.user_id,
            name=profile.name if profile else "Unknown",
            is_creator=p.is_creator,
            final_score=p.final_score,
            result=p.result.value,
            submitted_at=p.submitted_at,
        ))

    return MatchOut(
        id=match.id,
        challenge_id=match.challenge_id,
        status=match.status,
        participants=participants_out,
        created_at=match.created_at,
        completed_at=match.completed_at,
    )

# ── Forfeit endpoint ──────────────────────────────────────────────────────────

@router.post("/matches/{match_id}/forfeit", status_code=200)
def forfeit_match(
    match_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Forfeit a match. The calling player receives a loss; the opponent receives a win.
    The match is immediately marked complete.
    """
    match = _load_match(match_id, db)

    if match.status == "complete":
        raise HTTPException(status_code=400, detail="Match already completed")

    me  = _get_participant(match, current_user.id)
    opp = _get_opponent(match, current_user.id)

    me.result = MatchResultEnum.loss
    if opp:
        opp.result = MatchResultEnum.win

    match.status       = "complete"
    match.completed_at = datetime.utcnow()
    db.commit()

    return {"status": "forfeited", "match_id": match_id}

# ── Active matches ────────────────────────────────────────────────────────────

class ActiveMatchOut(BaseModel):
    match_id: str
    challenge_id: Optional[str]
    opponent_name: str
    opponent_id: str
    scoring: str
    distance: str
    arrow_count: Optional[int]
    match_type: str
    is_creator: bool

@router.get("/matches/mine/active", response_model=List[ActiveMatchOut])
def get_my_active_matches(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Return all non-complete matches the current user is a participant in.
    Used on page reload to rebuild client-side activeMatches state from server truth.
    Also drives the 'My Challenges' resume button for both creator and joiner.
    """
    participants = (
        db.query(MatchParticipant)
        .filter(
            MatchParticipant.user_id == current_user.id,
            MatchParticipant.is_bot == False,
        )
        .all()
    )

    result = []
    for p in participants:
        match = _load_match(p.match_id, db)
        if match.status == "complete":
            continue

        opp = _get_opponent(match, current_user.id)
        if not opp:
            continue

        opp_profile = db.query(Profile).filter(Profile.user_id == opp.user_id).first()
        ch = match.challenge

        result.append(ActiveMatchOut(
            match_id=match.id,
            challenge_id=match.challenge_id,
            opponent_name=opp_profile.name if opp_profile else "Opponent",
            opponent_id=opp.user_id,
            scoring=ch.scoring.value if ch else "total",
            distance=ch.distance if ch else "30m",
            arrow_count=ch.arrow_count if ch else 18,
            match_type=ch.match_type.value if ch else "live",
            is_creator=p.is_creator,
        ))

    return result

# ── Rematch endpoints ─────────────────────────────────────────────────────────

class RematchOut(BaseModel):
    status: str          # "proposed" | "accepted" | "declined"
    new_match_id: Optional[str] = None
    new_challenge_id: Optional[str] = None

@router.post("/matches/{match_id}/rematch", response_model=RematchOut)
async def propose_rematch(
    match_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Propose a rematch after a completed match.
    Creates a new Challenge (same config) and pushes 'rematch_proposed' WS event to opponent.
    """

    match = _load_match(match_id, db)
    if match.status != "complete":
        raise HTTPException(status_code=400, detail="Match is not complete yet")

    me = _get_participant(match, current_user.id)
    opp = _get_opponent(match, current_user.id)
    if not opp:
        raise HTTPException(status_code=400, detail="No opponent to rematch")

    if match.rematch_status == "proposed":
        raise HTTPException(status_code=400, detail="Rematch already proposed")

    # Clone the original challenge config
    ch = match.challenge
    if not ch:
        raise HTTPException(status_code=400, detail="Cannot rematch — original challenge config missing")

    # Create a new private challenge with same settings
    new_ch_id = str(uuid.uuid4())
    new_challenge = Challenge(
        id=new_ch_id,
        creator_id=current_user.id,
        match_type=MatchTypeEnum.private,   # rematch is always private
        scoring=ch.scoring,
        distance=ch.distance,
        arrow_count=ch.arrow_count,
        invite_message=None,
        deadline=None,
        is_private=True,
        is_active=True,
    )
    db.add(new_challenge)

    # Record rematch proposal on the original match
    match.rematch_status = "proposed"
    match.rematch_proposed_by = current_user.id
    db.commit()

    # Get proposer's name for the WS notification
    me_profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    proposer_name = me_profile.name if me_profile else "Opponent"

    # Push notification to opponent
    asyncio.ensure_future(manager.notify_user(opp.user_id, {
        "type": "rematch_proposed",
        "match_id": match_id,
        "challenge_id": new_ch_id,
        "proposed_by": proposer_name,
        "scoring": ch.scoring.value,
        "distance": ch.distance,
        "arrow_count": ch.arrow_count,
        "match_type": ch.match_type.value,
    }))

    return RematchOut(status="proposed", new_challenge_id=new_ch_id)

@router.post("/matches/{match_id}/rematch/accept", response_model=RematchOut)
async def accept_rematch(
    match_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Accept a rematch proposal. Joins the new challenge, creating a new match.
    Pushes 'rematch_accepted' WS event to the proposer with the new match_id.
    """

    match = _load_match(match_id, db)
    if match.rematch_status != "proposed":
        raise HTTPException(status_code=400, detail="No rematch proposal to accept")

    proposer_id = match.rematch_proposed_by
    if current_user.id == proposer_id:
        raise HTTPException(status_code=400, detail="Cannot accept your own rematch proposal")

    opp = _get_opponent(match, current_user.id)
    if not opp or opp.user_id != proposer_id:
        raise HTTPException(status_code=403, detail="Not your rematch")

    # Find the new challenge created by propose_rematch
    new_ch = (
        db.query(Challenge)
        .filter(
            Challenge.creator_id == proposer_id,
            Challenge.is_private == True,
            Challenge.is_active == True,
        )
        .order_by(Challenge.created_at.desc())
        .first()
    )
    if not new_ch:
        raise HTTPException(status_code=404, detail="Rematch challenge not found")

    # Create new match
    new_match_id = str(uuid.uuid4())
    new_match = Match(id=new_match_id, challenge_id=new_ch.id, status="active")
    db.add(new_match)
    db.add(MatchParticipant(match_id=new_match_id, user_id=proposer_id, is_creator=True))
    db.add(MatchParticipant(match_id=new_match_id, user_id=current_user.id, is_creator=False))
    new_ch.is_active = False

    match.rematch_status = "accepted"
    db.commit()

    me_profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    acceptor_name = me_profile.name if me_profile else "Opponent"

    ch = new_ch

    # Notify proposer that rematch was accepted
    asyncio.ensure_future(manager.notify_user(proposer_id, {
        "type": "rematch_accepted",
        "match_id": new_match_id,
        "challenge_id": new_ch.id,
        "opponent_name": acceptor_name,
        "scoring": ch.scoring.value,
        "distance": ch.distance,
        "arrow_count": ch.arrow_count,
        "match_type": ch.match_type.value,
    }))

    return RematchOut(
        status="accepted",
        new_match_id=new_match_id,
        new_challenge_id=new_ch.id,
    )

@router.post("/matches/{match_id}/rematch/decline", response_model=RematchOut)
async def decline_rematch(
    match_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Decline a rematch proposal. Notifies the proposer via WS."""

    match = _load_match(match_id, db)
    if match.rematch_status != "proposed":
        raise HTTPException(status_code=400, detail="No rematch proposal to decline")

    proposer_id = match.rematch_proposed_by
    match.rematch_status = "declined"
    db.commit()

    me_profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    decliner_name = me_profile.name if me_profile else "Opponent"

    asyncio.ensure_future(manager.notify_user(proposer_id, {
        "type": "rematch_declined",
        "match_id": match_id,
        "declined_by": decliner_name,
    }))

    return RematchOut(status="declined")
