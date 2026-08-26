"""
Stats endpoints:
  GET /api/history       — match history
  GET /api/ranking       — global leaderboard
  GET /api/ranking/me    — current user's rating summary
  GET /api/achievements  — achievement badges
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from core.deps import get_db, get_current_user
from models.models import (
    Challenge, ChallengeKindEnum, Match, MatchParticipant,
    MatchResultEnum, Profile, ScoringEnum, User,
)
from schemas.stats import AchievementItem, HistoryItem, RankingEntry, RankingSummary
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


def _calculate_ranking_stats(db: Session) -> dict:
    """Build cumulative rating stats from completed normal human matches.

    The rating is additive: every completed match contributes participation
    points, results contribute the largest component, and a total-score match
    can add a bounded score-quality component. This keeps a new athlete at
    zero while rewarding both activity and performance over time.
    """
    rows = (
        db.query(MatchParticipant, Match, Challenge)
        .join(Match, MatchParticipant.match_id == Match.id)
        .join(Challenge, Match.challenge_id == Challenge.id)
        .filter(
            MatchParticipant.result != MatchResultEnum.pending,
            MatchParticipant.is_bot == False,
            Challenge.challenge_kind == ChallengeKindEnum.normal,
        )
        .order_by(
            Match.completed_at.asc(),
            Match.created_at.asc(),
            MatchParticipant.submitted_at.asc(),
        )
        .all()
    )

    stats_by_user: dict = {}
    for participant, _match, challenge in rows:
        stats = stats_by_user.setdefault(
            participant.user_id,
            {
                "rating": 0,
                "wins": 0,
                "matches": 0,
                "total_score": 0,
                "score_count": 0,
                "current_streak": 0,
                "win_streak": 0,
            },
        )
        stats["matches"] += 1
        stats["rating"] += 10  # completed-match participation

        if participant.final_score is not None:
            stats["total_score"] += participant.final_score
            stats["score_count"] += 1

        if participant.result == MatchResultEnum.win:
            stats["wins"] += 1
            stats["current_streak"] += 1
            stats["win_streak"] = max(stats["win_streak"], stats["current_streak"])
            stats["rating"] += 100
            # Cap the per-win streak bonus so a long streak matters without
            # making all other results irrelevant.
            stats["rating"] += min(stats["current_streak"], 5) * 10
        elif participant.result == MatchResultEnum.draw:
            stats["current_streak"] = 0
            stats["rating"] += 40
        else:
            stats["current_streak"] = 0

        # Only total-score matches have a comparable arrow-score maximum.
        # The bounded bonus rewards score quality for both wins and losses.
        if (
            challenge.scoring == ScoringEnum.total
            and challenge.arrow_count
            and participant.final_score is not None
        ):
            max_score = challenge.arrow_count * 10
            score_ratio = max(0.0, min(1.0, participant.final_score / max_score))
            stats["rating"] += round(score_ratio * 25)

    return stats_by_user


def _ranked_users(db: Session, bow_type: Optional[str] = None) -> list:
    stats_by_user = _calculate_ranking_stats(db)
    profiles = {
        profile.user_id: profile
        for profile in db.query(Profile).filter(Profile.user_id.in_(stats_by_user)).all()
    }

    ranked = []
    for user_id, stats in stats_by_user.items():
        profile = profiles.get(user_id)
        if not profile or (bow_type and profile.bow_type.value != bow_type):
            continue
        avg_score = (
            stats["total_score"] / stats["score_count"]
            if stats["score_count"] else 0
        )
        ranked.append({
            "user_id": user_id,
            "profile": profile,
            "rating": stats["rating"],
            "wins": stats["wins"],
            "matches": stats["matches"],
            "avg_score": round(avg_score, 1),
            "win_streak": stats["win_streak"],
        })

    ranked.sort(
        key=lambda item: (
            -item["rating"],
            -item["wins"],
            -item["win_streak"],
            -item["avg_score"],
            -item["matches"],
            item["user_id"],
        )
    )
    return ranked


@router.get("/ranking", response_model=List[RankingEntry])
def get_ranking(
    bow_type: Optional[str] = None,
    limit:    int           = 50,
    db:       Session       = Depends(get_db),
):
    ranked = _ranked_users(db, bow_type)[:max(0, limit)]
    return [
        RankingEntry(
            rank=index,
            user_id=item["user_id"],
            name=item["profile"].name,
            bow_type=item["profile"].bow_type.value,
            rating=item["rating"],
            wins=item["wins"],
            matches_played=item["matches"],
            avg_score=item["avg_score"],
            win_streak=item["win_streak"],
        )
        for index, item in enumerate(ranked, 1)
    ]


@router.get("/ranking/me", response_model=RankingSummary)
def get_my_ranking(
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    ranked = _ranked_users(db)
    for index, item in enumerate(ranked, 1):
        if item["user_id"] == current_user.id:
            return RankingSummary(
                rank=index,
                rating=item["rating"],
                wins=item["wins"],
                matches_played=item["matches"],
                avg_score=item["avg_score"],
                win_streak=item["win_streak"],
            )

    return RankingSummary(
        rank=0,
        rating=0,
        wins=0,
        matches_played=0,
        avg_score=0,
        win_streak=0,
    )


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

    # Tiebreak children are represented by their parent match in history and
    # must not create an extra win or split the user's actual win sequence.
    completed_matches = []
    for p in participants:
        match = load_match(p.match_id, db)
        if match.challenge and match.challenge.challenge_kind == ChallengeKindEnum.tiebreak:
            continue
        completed_matches.append(p)

    total_matches = len(completed_matches)
    current_streak = 0
    max_win_streak = 0
    for p in completed_matches:
        if p.result == MatchResultEnum.win:
            current_streak += 1
            max_win_streak = max(max_win_streak, current_streak)
        else:
            current_streak = 0

    badge_defs = [
        ("streak_5",    "🔥", "5 Win Streak",  max_win_streak >= 5),
        ("streak_10",   "⚡", "10 Win Streak", max_win_streak >= 10),
        ("streak_25",   "👑", "25 Win Streak", max_win_streak >= 25),
        ("matches_10",  "🎯", "10 Matches",     total_matches >= 10),
        ("matches_50",  "🏹", "50 Matches",     total_matches >= 50),
        ("matches_100", "🌟", "100 Matches",    total_matches >= 100),
    ]
    return [
        AchievementItem(id=bid, icon=icon, label=label, earned=earned)
        for bid, icon, label, earned in badge_defs
    ]
