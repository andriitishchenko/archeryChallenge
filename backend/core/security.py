"""
Security helpers: password hashing, JWT creation and verification.

Uses the `bcrypt` library directly (not passlib) to avoid the passlib
bcrypt wrapper bug that raises ValueError for passwords > 72 bytes.
We also pre-truncate to 72 bytes ourselves for explicit, predictable behavior.
"""
from datetime import datetime, timedelta
from typing import Optional

import bcrypt
from jose import JWTError, jwt

from core.config import settings

# bcrypt hard-limits passwords to 72 bytes.
# We truncate explicitly so hash() and verify() always agree on the same bytes.
_BCRYPT_MAX_BYTES = 72
_BCRYPT_ROUNDS    = 12


def _trim_bytes(plain: str) -> bytes:
    """UTF-8 encode and truncate to 72 bytes (safe for multi-byte chars)."""
    raw = plain.encode("utf-8")
    if len(raw) <= _BCRYPT_MAX_BYTES:
        return raw
    raw = raw[:_BCRYPT_MAX_BYTES]
    # Strip any partial multi-byte trailing sequence
    return raw.decode("utf-8", errors="ignore").encode("utf-8")


def hash_password(plain: str) -> str:
    hashed = bcrypt.hashpw(_trim_bytes(plain), bcrypt.gensalt(rounds=_BCRYPT_ROUNDS))
    return hashed.decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_trim_bytes(plain), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str, expires_minutes: Optional[int] = None) -> str:
    exp = datetime.utcnow() + timedelta(
        minutes=expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload = {"sub": user_id, "exp": exp, "type": "access"}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    exp = datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"sub": user_id, "exp": exp, "type": "refresh"}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    """Decode and validate a JWT. Returns payload dict or None."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload
    except JWTError:
        return None


def get_user_id_from_token(token: str) -> Optional[str]:
    payload = decode_token(token)
    if payload is None:
        return None
    return payload.get("sub")
