from datetime import datetime
from typing import Optional
from pydantic import BaseModel
from models.models import MatchTypeEnum, ScoringEnum, DisciplineEnum


class ChallengeCreate(BaseModel):
    match_type:     MatchTypeEnum
    discipline:     DisciplineEnum = DisciplineEnum.target
    scoring:        ScoringEnum
    distance:       str
    arrow_count:    Optional[int] = 18
    invite_message: Optional[str] = None
    deadline:       Optional[datetime] = None
    is_private:     bool = False


class ChallengeOut(BaseModel):
    id:                   str
    creator_id:           str
    creator_name:         str
    creator_gender:       str
    creator_age:          str
    creator_bow_type:     str
    creator_skill_level:  str
    creator_country:      str
    match_type:           str
    discipline:           str
    scoring:              str
    distance:             str
    arrow_count:          Optional[int]
    invite_message:       Optional[str]
    deadline:             Optional[datetime]
    is_private:           bool
    is_active:            bool
    created_at:           datetime
    # Active-match fields — null for public list
    match_id:             Optional[str]  = None
    opponent_name:        Optional[str]  = None
    opponent_id:          Optional[str]  = None
    is_creator:           Optional[bool] = None
    tiebreak_required:    bool           = False
    tiebreak_match_id:    Optional[str]  = None

    class Config:
        from_attributes = True


class JoinResponse(BaseModel):
    match_id:     str
    challenge_id: str
    message:      str
    scoring:      str
    distance:     str
    arrow_count:  Optional[int]
    creator_name: str
    match_type:   str
    discipline:   str
