"""
Authentication endpoints:
  POST /api/guest            — issue a guest userID + token
  POST /api/auth/register    — register email+password (reuses existing userID)
  POST /api/auth/login       — login with email+password
  POST /api/auth/forgot-password — request a password reset email
  POST /api/auth/reset-password  — set a new password with a reset token
  POST /api/auth/refresh     — exchange refresh token for new access token
  GET  /api/auth/me          — return current user info
"""
import time
import random
import string
from datetime import datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from core.deps import get_db, get_current_user, check_rate_limit
from core.security import (
    hash_password, verify_password,
    create_access_token, create_refresh_token,
    decode_token, generate_password_reset_token, hash_password_reset_token,
)
from models.models import PasswordResetToken, User
from core.config import settings
from services.email import send_password_reset_email
from schemas.auth import (
    GuestResponse, RegisterRequest, LoginRequest,
    TokenResponse, RefreshRequest, MeResponse, ForgotPasswordRequest,
    ResetPasswordRequest, PasswordResetResponse,
)

router = APIRouter(prefix="/api", tags=["auth"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _base36_encode(number: int) -> str:
    chars = string.digits + string.ascii_uppercase
    result = ""
    while number:
        number, rem = divmod(number, 36)
        result = chars[rem] + result
    return result or "0"


def _generate_user_id() -> str:
    ts   = _base36_encode(int(time.time() * 1000))
    rand = "".join(random.choices(string.ascii_uppercase + string.digits, k=8))
    return f"AM-{ts}-{rand}"


def _create_tokens(user_id: str) -> dict:
    return {
        "access_token":  create_access_token(user_id),
        "refresh_token": create_refresh_token(user_id),
        "token_type":    "bearer",
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/guest", response_model=GuestResponse)
def create_guest(db: Session = Depends(get_db)):
    user_id = _generate_user_id()
    db.add(User(id=user_id, is_guest=True))
    db.commit()
    return GuestResponse(user_id=user_id, **_create_tokens(user_id))


@router.post("/auth/register", response_model=TokenResponse, dependencies=[Depends(check_rate_limit)])
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == req.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")

    if req.existing_user_id:
        user = db.query(User).filter(User.id == req.existing_user_id).first()
        if not user:
            raise HTTPException(status_code=404, detail="Guest user not found")
        user.email           = req.email
        user.hashed_password = hash_password(req.password)
        user.is_guest        = False
    else:
        user = User(
            id               = _generate_user_id(),
            email            = req.email,
            hashed_password  = hash_password(req.password),
            is_guest         = False,
        )
        db.add(user)

    db.commit()
    return TokenResponse(user_id=user.id, is_guest=False, **_create_tokens(user.id))


@router.post("/auth/login", response_model=TokenResponse, dependencies=[Depends(check_rate_limit)])
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email).first()
    if not user or not user.hashed_password or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user.last_seen = datetime.utcnow()
    db.commit()
    return TokenResponse(user_id=user.id, is_guest=user.is_guest, **_create_tokens(user.id))


@router.post(
    "/auth/forgot-password",
    response_model=PasswordResetResponse,
    dependencies=[Depends(check_rate_limit)],
)
def forgot_password(req: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Queue a reset email without revealing whether the address is registered."""
    message = "If an account exists for this email, a password reset link has been sent."
    email = str(req.email).lower()
    user = db.query(User).filter(func.lower(User.email) == email).first()

    if not user or user.is_guest or not user.hashed_password or not user.email:
        return PasswordResetResponse(message=message)

    now = datetime.utcnow()
    # Only the newest outstanding token remains usable.
    db.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == user.id,
        PasswordResetToken.used_at.is_(None),
    ).update({"used_at": now}, synchronize_session=False)

    raw_token = generate_password_reset_token()
    db.add(PasswordResetToken(
        user_id=user.id,
        token_hash=hash_password_reset_token(raw_token),
        expires_at=now + timedelta(minutes=settings.PASSWORD_RESET_EXPIRE_MINUTES),
    ))
    db.commit()

    reset_url = f"{settings.APP_BASE_URL}/?reset_token={quote(raw_token)}"
    send_password_reset_email(user.email, reset_url)
    return PasswordResetResponse(message=message)


@router.post(
    "/auth/reset-password",
    response_model=PasswordResetResponse,
    dependencies=[Depends(check_rate_limit)],
)
def reset_password(req: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Consume a valid one-time token and replace the account password."""
    now = datetime.utcnow()
    reset = db.query(PasswordResetToken).filter(
        PasswordResetToken.token_hash == hash_password_reset_token(req.token),
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.expires_at > now,
    ).first()
    if not reset:
        raise HTTPException(status_code=400, detail="Reset link is invalid or expired")

    user = db.query(User).filter(User.id == reset.user_id).first()
    if not user or user.is_guest or not user.email:
        raise HTTPException(status_code=400, detail="Reset link is invalid or expired")

    user.hashed_password = hash_password(req.password)
    user.is_guest = False
    reset.used_at = now
    db.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == user.id,
        PasswordResetToken.used_at.is_(None),
    ).update({"used_at": now}, synchronize_session=False)
    db.commit()
    return PasswordResetResponse(message="Your password has been reset. You can now sign in.")


@router.post("/auth/refresh", response_model=TokenResponse)
def refresh_token(req: RefreshRequest, db: Session = Depends(get_db)):
    payload = decode_token(req.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    user = db.query(User).filter(User.id == payload.get("sub")).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return TokenResponse(user_id=user.id, is_guest=user.is_guest, **_create_tokens(user.id))


@router.get("/auth/me", response_model=MeResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return MeResponse(
        user_id    = current_user.id,
        email      = current_user.email,
        is_guest   = current_user.is_guest,
        created_at = current_user.created_at,
    )
