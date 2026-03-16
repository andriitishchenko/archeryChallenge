"""
Application settings — loaded once from environment variables at import time.
"""
import os
from typing import List


class Settings:
    # Core
    APP_NAME: str = "ArrowMatch API"
    VERSION:  str = "4.0.0"
    DEBUG:    bool = os.getenv("DEBUG", "false").lower() == "true"

    # Security
    SECRET_KEY:                  str = os.getenv("SECRET_KEY", "change-me-in-production-use-long-random-string")
    ALGORITHM:                   str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))
    REFRESH_TOKEN_EXPIRE_DAYS:   int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS",  "30"))

    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./arrowmatch.db")

    # CORS
    CORS_ORIGINS: List[str] = [
        o.strip() for o in os.getenv(
            "CORS_ORIGINS",
            "http://localhost:3000,http://localhost:8000,http://127.0.0.1:8000",
        ).split(",")
    ]

    # Rate limiting (auth endpoints)
    AUTH_RATE_LIMIT:  int = int(os.getenv("AUTH_RATE_LIMIT",  "5"))    # attempts per window
    AUTH_RATE_WINDOW: int = int(os.getenv("AUTH_RATE_WINDOW", "900"))  # seconds (15 min)

    # Matchmaking
    BOT_WAIT_SECONDS:    int = int(os.getenv("BOT_WAIT_SECONDS",    "8"))
    MATCHMAKING_TIMEOUT: int = int(os.getenv("MATCHMAKING_TIMEOUT", "30"))

    # Expiry background task
    EXPIRY_CHECK_INTERVAL_SECONDS: int = int(os.getenv("EXPIRY_CHECK_INTERVAL_SECONDS", "60"))
    MATCH_INACTIVITY_SECONDS:      int = int(os.getenv("MATCH_INACTIVITY_SECONDS", str(48 * 3600)))


settings = Settings()
