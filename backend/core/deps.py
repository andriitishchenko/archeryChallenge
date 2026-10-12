"""
FastAPI dependency functions for authentication, rate limiting, and DB access.
"""
import threading
import time
from collections import OrderedDict
from typing import Optional

from fastapi import Depends, HTTPException, Request, status, Header
from sqlalchemy.orm import Session

from core.security import get_user_id_from_token
from models.database import get_db
from models.models import User
from core.config import settings

# Process-local rate limit store; production runs one worker until this state is shared.
_RATE_STORE_MAX_KEYS = 10_000
_RATE_STORE_SWEEP_SECONDS = 60
_rate_store: OrderedDict[tuple[str, str], list[float]] = OrderedDict()
_rate_store_lock = threading.Lock()
_rate_store_last_sweep = 0.0


def _prune_rate_store(now: float, window: int) -> None:
    """Remove expired buckets periodically to keep the process-local store bounded."""
    global _rate_store_last_sweep
    if now - _rate_store_last_sweep < _RATE_STORE_SWEEP_SECONDS:
        return
    for key, timestamps in list(_rate_store.items()):
        recent = [timestamp for timestamp in timestamps if now - timestamp < window]
        if recent:
            _rate_store[key] = recent
        else:
            del _rate_store[key]
    _rate_store_last_sweep = now


def check_rate_limit(request: Request) -> None:
    """
    Apply a per-client sliding-window limit without trusting forwarded headers.

    Uvicorn may rewrite request.client when forwarded headers come from a
    configured trusted proxy. Direct clients cannot choose their own rate-limit key.
    """
    ip = request.client.host if request.client else "unknown"
    is_guest_creation = request.url.path == "/api/guest"
    bucket = "guest" if is_guest_creation else "auth"
    window = settings.AUTH_RATE_WINDOW
    limit = settings.GUEST_RATE_LIMIT if is_guest_creation else settings.AUTH_RATE_LIMIT
    now = time.monotonic()

    with _rate_store_lock:
        _prune_rate_store(now, window)
        key = (bucket, ip)
        recent = [timestamp for timestamp in _rate_store.get(key, []) if now - timestamp < window]
        if len(recent) >= limit:
            _rate_store[key] = recent
            _rate_store.move_to_end(key)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Too many attempts. Try again in {max(1, window // 60)} minutes.",
                headers={"Retry-After": str(window)},
            )
        recent.append(now)
        if key not in _rate_store and len(_rate_store) >= _RATE_STORE_MAX_KEYS:
            _rate_store.popitem(last=False)
        _rate_store[key] = recent
        _rate_store.move_to_end(key)

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
