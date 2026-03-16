from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class HistoryItem(BaseModel):
    match_id:            str
    opponent_name:       str
    distance:            str
    scoring:             str
    my_score:            Optional[int]
    opponent_score:      Optional[int]
    tiebreak_my_arrow:   Optional[int]
    tiebreak_opp_arrow:  Optional[int]
    result:              str
    date:                datetime


class RankingEntry(BaseModel):
    rank:           int
    user_id:        str
    name:           str
    bow_type:       str
    wins:           int
    matches_played: int
    avg_score:      float


class AchievementItem(BaseModel):
    id:     str
    icon:   str
    label:  str
    earned: bool
