from datetime import datetime
from pydantic import BaseModel, field_validator
from models.models import GenderEnum, AgeEnum, BowTypeEnum, SkillLevelEnum


class ProfileRequest(BaseModel):
    name: str
    gender: GenderEnum
    age: AgeEnum
    bow_type: BowTypeEnum
    skill_level: SkillLevelEnum
    country: str

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 64:
            raise ValueError("Name must be 1–64 characters")
        return v

    @field_validator("country")
    @classmethod
    def country_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 64:
            raise ValueError("Country required")
        return v


class ProfileResponse(BaseModel):
    user_id: str
    name: str
    gender: str
    age: str
    bow_type: str
    skill_level: str
    country: str
    updated_at: datetime

    class Config:
        from_attributes = True
