"""
Application settings — loaded once from environment variables at import time.
"""
import os
from email.utils import parseaddr
from pathlib import Path
from typing import List
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)

_DEVELOPMENT_SECRET = "change-me-in-production-use-long-random-string"
_RESERVED_HOSTS = {"example", "example.com", "example.net", "example.org", "localhost"}
_RESERVED_HOST_SUFFIXES = (".localhost", ".local", ".invalid", ".test", ".example")


def _is_placeholder_host(hostname: str) -> bool:
    normalized = hostname.lower().rstrip(".")
    return normalized in _RESERVED_HOSTS or normalized.endswith(_RESERVED_HOST_SUFFIXES)


def _read_bool(name: str, default: str) -> bool:
    value = os.getenv(name, default).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean value")


def _read_csv(name: str, default: str) -> List[str]:
    return [value.strip() for value in os.getenv(name, default).split(",") if value.strip()]


def _default_cors_origins(app_env: str) -> str:
    if app_env == "production":
        return ""
    return "http://localhost:3000,http://localhost:8000,http://127.0.0.1:8000"


def _normalize_database_url(value: str) -> str:
    if value.startswith("postgres://"):
        return "postgresql+psycopg://" + value[len("postgres://"):]
    if value.startswith("postgresql://"):
        return "postgresql+psycopg://" + value[len("postgresql://"):]
    return value


class Settings:
    # Core
    APP_NAME: str = "ArrowMatch API"
    VERSION:  str = "4.0.0"
    APP_ENV: str = os.getenv("APP_ENV", "development").strip().lower()
    DEBUG:    bool = _read_bool("DEBUG", "false")

    # Security
    SECRET_KEY:                  str = os.getenv("SECRET_KEY", _DEVELOPMENT_SECRET)
    ALGORITHM:                   str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))
    REFRESH_TOKEN_EXPIRE_DAYS:   int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS",  "30"))
    PASSWORD_RESET_EXPIRE_MINUTES: int = int(os.getenv("PASSWORD_RESET_EXPIRE_MINUTES", "60"))

    # Password reset email delivery (SMTP is optional for local development)
    APP_BASE_URL:  str = os.getenv("APP_BASE_URL", "http://localhost:8000").rstrip("/")
    SMTP_HOST:     str = os.getenv("SMTP_HOST", "")
    SMTP_PORT:     int = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USERNAME: str = os.getenv("SMTP_USERNAME", "")
    SMTP_PASSWORD: str = os.getenv("SMTP_PASSWORD", "")
    SMTP_USE_TLS:  bool = _read_bool("SMTP_USE_TLS", "true")
    EMAIL_FROM:    str = os.getenv("EMAIL_FROM", "noreply@arrowmatch.local")

    # Database
    DATABASE_URL: str = _normalize_database_url(os.getenv("DATABASE_URL", "sqlite:///./arrowmatch.db"))

    # CORS
    CORS_ORIGINS: List[str] = _read_csv("CORS_ORIGINS", _default_cors_origins(APP_ENV))

    # Rate limiting (auth endpoints)
    AUTH_RATE_LIMIT:  int = int(os.getenv("AUTH_RATE_LIMIT",  "5"))    # attempts per window
    AUTH_RATE_WINDOW: int = int(os.getenv("AUTH_RATE_WINDOW", "900"))  # seconds (15 min)
    GUEST_RATE_LIMIT: int = int(os.getenv("GUEST_RATE_LIMIT", "20"))

    # Matchmaking
    BOT_WAIT_SECONDS:    int = int(os.getenv("BOT_WAIT_SECONDS",    "8"))
    MATCHMAKING_TIMEOUT: int = int(os.getenv("MATCHMAKING_TIMEOUT", "30"))

    # Expiry background task
    EXPIRY_CHECK_INTERVAL_SECONDS: int = int(os.getenv("EXPIRY_CHECK_INTERVAL_SECONDS", "60"))
    MATCH_INACTIVITY_SECONDS:      int = int(os.getenv("MATCH_INACTIVITY_SECONDS", str(48 * 3600)))

    def validate_for_startup(self) -> None:
        """Reject deployment settings that are unsafe for production use."""
        if self.APP_ENV not in {"development", "test", "production"}:
            raise RuntimeError("APP_ENV must be development, test, or production")
        if self.APP_ENV != "production":
            return

        errors = []
        normalized_secret = self.SECRET_KEY.strip().lower()
        if (
            len(self.SECRET_KEY.encode("utf-8")) < 32
            or len(set(self.SECRET_KEY)) < 8
            or self.SECRET_KEY != self.SECRET_KEY.strip()
            or not self.SECRET_KEY.strip()
            or normalized_secret in {_DEVELOPMENT_SECRET, "your-secret-key", "secret"}
            or normalized_secret.startswith(("replace-with-", "your-very-long-random"))
        ):
            errors.append("SECRET_KEY must be a non-placeholder value with at least 32 bytes")

        database_url = urlparse(self.DATABASE_URL)
        database_scheme = database_url.scheme
        if database_scheme != "postgresql+psycopg":
            errors.append("DATABASE_URL must use PostgreSQL with the psycopg driver")
        ssl_modes = parse_qs(database_url.query).get("sslmode", [])
        if len(ssl_modes) != 1 or ssl_modes[0].lower() not in {"require", "verify-ca", "verify-full"}:
            errors.append("DATABASE_URL must require TLS with a secure PostgreSQL sslmode")
        if self.DEBUG:
            errors.append("DEBUG must be false in production")

        app_base = urlparse(self.APP_BASE_URL)
        try:
            app_base_port = app_base.port
        except ValueError:
            app_base_port = None
            errors.append("APP_BASE_URL must have a valid port")
        if app_base_port is not None and not 1 <= app_base_port <= 65535:
            errors.append("APP_BASE_URL must have a valid port")
        if (
            app_base.scheme != "https"
            or not app_base.hostname
            or app_base.username is not None
            or app_base.password is not None
            or (
                app_base.hostname
                and (
                    app_base.hostname.lower() in {"localhost", "127.0.0.1", "::1"}
                    or _is_placeholder_host(app_base.hostname)
                )
            )
            or app_base.query
            or app_base.fragment
        ):
            errors.append("APP_BASE_URL must be an HTTPS URL in production")

        for origin in self.CORS_ORIGINS:
            parsed = urlparse(origin)
            try:
                port = parsed.port
            except ValueError:
                port = None
                errors.append("CORS_ORIGINS must contain valid HTTPS origins")
                break
            if port is not None and not 1 <= port <= 65535:
                errors.append("CORS_ORIGINS must contain valid HTTPS origins")
                break
            if parsed.hostname and ":" in parsed.hostname:
                hostname = f"[{parsed.hostname}]"
            else:
                hostname = parsed.hostname or ""
            canonical_netloc = hostname + (f":{port}" if port and port != 443 else "")
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.netloc != canonical_netloc
                or parsed.path
                or parsed.query
                or parsed.fragment
                or parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1"}
                or _is_placeholder_host(parsed.hostname)
            ):
                errors.append("CORS_ORIGINS may contain only explicit HTTPS origins in production")
                break

        if not self.SMTP_HOST.strip():
            errors.append("SMTP_HOST must be configured in production")
        elif _is_placeholder_host(self.SMTP_HOST.strip()):
            errors.append("SMTP_HOST must use a configured mail server hostname")
        if not self.SMTP_USE_TLS:
            errors.append("SMTP_USE_TLS must be enabled in production")
        if not 1 <= self.SMTP_PORT <= 65535:
            errors.append("SMTP_PORT must be between 1 and 65535")
        sender = parseaddr(self.EMAIL_FROM)[1]
        sender_domain = sender.rsplit("@", 1)[-1].lower() if "@" in sender else ""
        if (
            sender.count("@") != 1
            or not sender_domain
            or _is_placeholder_host(sender_domain)
        ):
            errors.append("EMAIL_FROM must be a valid production email address")
        if bool(self.SMTP_USERNAME.strip()) != bool(self.SMTP_PASSWORD):
            errors.append("SMTP_USERNAME and SMTP_PASSWORD must be configured together")
        if (
            self.AUTH_RATE_LIMIT < 1
            or self.GUEST_RATE_LIMIT < 1
            or self.AUTH_RATE_WINDOW < 1
            or self.PASSWORD_RESET_EXPIRE_MINUTES < 1
            or self.EXPIRY_CHECK_INTERVAL_SECONDS < 1
            or self.MATCH_INACTIVITY_SECONDS < 1
            or self.BOT_WAIT_SECONDS < 1
            or self.MATCHMAKING_TIMEOUT < 1
        ):
            errors.append("Auth rate limits and their window must be positive")
        if self.ACCESS_TOKEN_EXPIRE_MINUTES < 1 or self.REFRESH_TOKEN_EXPIRE_DAYS < 1:
            errors.append("Token expiry values must be positive")

        if errors:
            raise RuntimeError("Invalid production configuration: " + "; ".join(errors))


settings = Settings()
