"""
Stats endpoints:
  GET /api/history       — match history
  GET /api/ranking       — global leaderboard
  GET /api/achievements  — achievement badges
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from core.deps import get_db, get_current_user
from models.models import (
    Challenge, ChallengeKindEnum, Match, MatchParticipant,
    MatchResultEnum, Profile, User,
)
from schemas.stats import AchievementItem, HistoryItem, RankingEntry
from services.match import get_opponent, load_match
from services.tiebreak import get_tiebreak_match

router = APIRouter(prefix="/api", tags=["stats"])


@router.get("/history", response_model=List[HistoryItem])
def get_history(
    limit:        int     = 30,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    participants = (
        db.query(MatchParticipant)
        .filter(
            MatchParticipant.user_id == current_user.id,
            MatchParticipant.result  != MatchResultEnum.pending,
        )
        .order_by(MatchParticipant.submitted_at.desc())
        .limit(limit * 3)
        .all()
    )

    result = []
    for p in participants:
        if len(result) >= limit:
            break
        match = load_match(p.match_id, db)
        ch    = match.challenge

        # Skip tiebreak sub-matches — not standalone history entries
        if ch and ch.challenge_kind == ChallengeKindEnum.tiebreak:
            continue

        opp = get_opponent(match, current_user.id)
        if not opp:
            continue

        # Effective result: for total-tied matches look up tiebreak result
        my_result = p.result
        if my_result == MatchResultEnum.pending:
            tb = get_tiebreak_match(match.id, db)
            if tb and tb.status == "complete":
                tb_me = next((x for x in tb.participants if x.user_id == current_user.id), None)
                if tb_me:
                    my_result = tb_me.result
        if my_result == MatchResultEnum.pending:
            continue

        # Tiebreak arrow values for display
        tb_my_arrow = tb_opp_arrow = None
        if p.final_score is not None and p.final_score == opp.final_score:
            tb = get_tiebreak_match(match.id, db)
            if tb and tb.status == "complete":
                tb_me_p  = next((x for x in tb.participants if x.user_id == current_user.id), None)
                tb_opp_p = next((x for x in tb.participants if x.user_id != current_user.id), None)
                if tb_me_p:  tb_my_arrow  = tb_me_p.final_score
                if tb_opp_p: tb_opp_arrow = tb_opp_p.final_score

        opp_profile = db.query(Profile).filter(Profile.user_id == opp.user_id).first()
        result.append(HistoryItem(
            match_id           = match.id,
            opponent_name      = opp_profile.name if opp_profile else "Unknown",
            distance           = ch.distance if ch else "—",
            scoring            = ch.scoring.value if ch else "total",
            my_score           = p.final_score,
            opponent_score     = opp.final_score,
            tiebreak_my_arrow  = tb_my_arrow,
            tiebreak_opp_arrow = tb_opp_arrow,
            result             = my_result.value,
            date               = p.submitted_at or match.created_at,
        ))
    return result


@router.get("/ranking", response_model=List[RankingEntry])
def get_ranking(
    bow_type: Optional[str] = None,
    limit:    int           = 50,
    db:       Session       = Depends(get_db),
):
    participants = (
        db.query(MatchParticipant)
        .join(Match,     MatchParticipant.match_id    == Match.id)
        .join(Challenge, Match.challenge_id            == Challenge.id)
        .filter(
            MatchParticipant.result   != MatchResultEnum.pending,
            MatchParticipant.is_bot   == False,
            Challenge.challenge_kind  == ChallengeKindEnum.normal,
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
            rank=rank, user_id=uid, name=profile.name, bow_type=profile.bow_type.value,
            wins=stats["wins"], matches_played=stats["matches"], avg_score=round(avg, 1),
        ))
    return result


@router.get("/achievements", response_model=List[AchievementItem])
def get_achievements(
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    participants = (
        db.query(MatchParticipant)
        .filter(
            MatchParticipant.user_id == current_user.id,
            MatchParticipant.result  != MatchResultEnum.pending,
        )
        .order_by(MatchParticipant.submitted_at.desc())
        .all()
    )

    total_matches = len(participants)
    win_streak    = 0
    for p in participants:
        if p.result == MatchResultEnum.win:
            win_streak += 1
        else:
            break

    badge_defs = [
        ("streak_5",    "🔥", "5 Win Streak",  win_streak    >= 5),
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
