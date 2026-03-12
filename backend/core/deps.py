"""
FastAPI dependency functions for authentication, rate limiting, and DB access.
"""
import time
from collections import defaultdict
from typing import Optional

from fastapi import Depends, HTTPException, status, Header
from sqlalchemy.orm import Session

from core.security import get_user_id_from_token
from models.database import get_db
from models.models import User
from core.config import settings

# In-memory rate limit store: {ip: [(timestamp, count)]}
# For production, replace with Redis
_rate_store: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(x_forwarded_for: Optional[str] = Header(None),
                     x_real_ip: Optional[str] = Header(None)) -> None:
    """
    Simple sliding-window rate limiter for auth endpoints.
    Allows AUTH_RATE_LIMIT requests per AUTH_RATE_WINDOW seconds per IP.
    """
    ip = x_real_ip or (x_forwarded_for.split(",")[0].strip() if x_forwarded_for else "unknown")
    window = settings.AUTH_RATE_WINDOW
    limit = settings.AUTH_RATE_LIMIT
    now = time.time()

    # Prune old entries
    _rate_store[ip] = [t for t in _rate_store[ip] if now - t < window]

    if len(_rate_store[ip]) >= limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many attempts. Try again in {window // 60} minutes.",
            headers={"Retry-After": str(window)},
        )
    _rate_store[ip].append(now)


def get_current_user_id(authorization: Optional[str] = Header(None)) -> str:
    """Extract and validate Bearer token, return user_id."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.split(" ", 1)[1]
    user_id = get_user_id_from_token(token)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user_id


def get_current_user(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
) -> User:
    """Load User model for the authenticated user."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def get_current_user_optional(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Like get_current_user but returns None instead of raising if unauthenticated."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    user_id = get_user_id_from_token(token)
    if not user_id:
        return None
    return db.query(User).filter(User.id == user_id).first()
