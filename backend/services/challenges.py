"""
Challenge serialisation helper shared by routers/challenges.py and routers/stats.py.
Extracted here to break the circular import that existed in v3
(scores.py imported _challenge_to_out directly from routers/challenges.py).
"""
from models.models import Challenge


def challenge_to_out(ch: Challenge, **extra) -> dict:
    """
    Serialize a Challenge ORM object to a plain dict compatible with ChallengeOut.
    Pass keyword-arg overrides to inject active-match fields.
    """
    p = ch.creator.profile
    return {
        "id":                  ch.id,
        "creator_id":          ch.creator_id,
        "creator_name":        p.name,
        "creator_gender":      p.gender.value,
        "creator_age":         p.age.value,
        "creator_bow_type":    p.bow_type.value,
        "creator_skill_level": p.skill_level.value,
        "creator_country":     p.country,
        "match_type":          ch.match_type.value,
        "discipline":          ch.discipline.value,
        "scoring":             ch.scoring.value,
        "distance":            ch.distance,
        "arrow_count":         ch.arrow_count,
        "invite_message":      ch.invite_message,
        "deadline":            ch.deadline.isoformat() if ch.deadline else None,
        "is_private":          ch.is_private,
        "is_active":           ch.is_active,
        "created_at":          ch.created_at.isoformat() if ch.created_at else None,
        # Active-match fields — default null; callers override via **extra
        "match_id":            None,
        "opponent_name":       None,
        "opponent_id":         None,
        "is_creator":          None,
        "tiebreak_required":   False,
        "tiebreak_match_id":   None,
        "rematch_pending":     False,
        "is_rematch":          False,
        **extra,
    }
