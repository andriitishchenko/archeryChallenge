from datetime import datetime
from typing import List, Optional, Dict
from pydantic import BaseModel, field_validator


class ArrowScoreItem(BaseModel):
    arrow_index: int
    value:       int
    set_number:  Optional[int] = None

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
    set_number: int        # 1-based; 0 for sudden-death tiebreak
    arrows:     List[int]  # exactly 3 (or 1 for sudden-death)

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
    set_number:        int
    both_submitted:    bool
    my_set_total:      int
    opp_set_total:     Optional[int]
    set_winner:        Optional[str]   # "me" | "opponent" | "draw"
    my_set_points:     int
    opp_set_points:    int
    match_complete:    bool
    match_winner:      Optional[str]   # "me" | "opponent" | None
    match_result:      Optional[str]   # alias for match_winner — used by client
    tiebreak_required: bool
    next_first_to_act: Optional[str]   # user_id
    judge_status:      str


class ScoreSubmission(BaseModel):
    arrows: List[ArrowScoreItem]


class MatchStatusOut(BaseModel):
    id:                 str
    status:             str
    scoring:            str   # "total" | "sets" | "tiebreak"
    my_score:           Optional[int]
    opp_score:          Optional[int]
    opp_submitted:      bool
    my_submitted:       bool
    tiebreak_my_arrow:  Optional[int]
    tiebreak_opp_arrow: Optional[int]
    result:             Optional[str]
    my_set_points:      int
    opp_set_points:     int
    current_set:        int
    sets:               List[Dict]
    first_to_act:             Optional[str]
    judge_status:             str
    # Individual arrow values opponent submitted for the current set (null if not yet submitted)
    opp_current_set_arrows:   Optional[List[Optional[int]]] = None


class MatchParticipantOut(BaseModel):
    user_id:      str
    name:         str
    is_creator:   bool
    final_score:  Optional[int]
    result:       str
    submitted_at: Optional[datetime]


class MatchOut(BaseModel):
    id:           str
    challenge_id: Optional[str]
    status:       str
    participants: List[MatchParticipantOut]
    created_at:   datetime
    completed_at: Optional[datetime]


class ActiveMatchOut(BaseModel):
    match_id:           str
    challenge_id:       Optional[str]
    opponent_name:      str
    opponent_id:        str
    scoring:            str
    distance:           str
    arrow_count:        Optional[int]
    match_type:         str
    discipline:         str
    is_creator:         bool
    first_to_act:       Optional[str]
    challenge_kind:     str            # "normal" | "tiebreak"
    parent_match_id:    Optional[str]
    tiebreak_required:  bool
    tiebreak_match_id:  Optional[str]


class RematchOut(BaseModel):
    status:           str
    new_match_id:     Optional[str] = None
    new_challenge_id: Optional[str] = None
    opponent_name:    Optional[str] = None
    scoring:          Optional[str] = None
    distance:         Optional[str] = None
    arrow_count:      Optional[int] = None
    match_type:       Optional[str] = None
