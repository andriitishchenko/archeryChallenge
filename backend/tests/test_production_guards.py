import asyncio
from collections import OrderedDict
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Request

from core import deps
from core.config import Settings
from models.models import AgeEnum, BowTypeEnum, GenderEnum, Profile, SkillLevelEnum, User
from ws.manager import ConnectionManager
from ws.routes import _is_valid_arrow_message, _load_matchmaking_profile, _sanitize_matchmaking_filters

from support import DatabaseTestCase


def production_config(**overrides):
    values = {
        "APP_ENV": "production",
        "SECRET_KEY": "3f7b1d9e2c6a4b8f0e5d7c1a9b3f6e2d8c4a1b7f0e5d9c3a",
        "DATABASE_URL": "postgresql+psycopg://arrow:secret@db.example/arrowmatch?sslmode=verify-full",
        "DEBUG": False,
        "APP_BASE_URL": "https://arrowmatch.com",
        "CORS_ORIGINS": ["https://arrowmatch.com"],
        "SMTP_HOST": "smtp.arrowmatch.com",
        "SMTP_PORT": 587,
        "SMTP_USERNAME": "",
        "SMTP_PASSWORD": "",
        "SMTP_USE_TLS": True,
        "EMAIL_FROM": "noreply@arrowmatch.com",
        "AUTH_RATE_LIMIT": 5,
        "GUEST_RATE_LIMIT": 20,
        "AUTH_RATE_WINDOW": 900,
        "BOT_WAIT_SECONDS": 8,
        "MATCHMAKING_TIMEOUT": 30,
        "PASSWORD_RESET_EXPIRE_MINUTES": 60,
        "EXPIRY_CHECK_INTERVAL_SECONDS": 60,
        "MATCH_INACTIVITY_SECONDS": 172800,
        "ACCESS_TOKEN_EXPIRE_MINUTES": 60,
        "REFRESH_TOKEN_EXPIRE_DAYS": 30,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def request_from(client_ip, path="/api/auth/login", headers=()):
    encoded_headers = [(name.lower().encode(), value.encode()) for name, value in headers]
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "query_string": b"",
        "headers": encoded_headers,
        "client": (client_ip, 12345),
        "server": ("testserver", 80),
    })


class ProductionConfigTests(TestCase):
    def test_valid_production_settings_pass_startup_validation(self):
        Settings.validate_for_startup(production_config())
        Settings.validate_for_startup(production_config(CORS_ORIGINS=[]))

    def test_development_defaults_are_rejected_in_production(self):
        unsafe = production_config(
            SECRET_KEY="a" * 48,
            DATABASE_URL="sqlite:///./arrowmatch.db",
            DEBUG=True,
            APP_BASE_URL="http://localhost:8000",
            CORS_ORIGINS=["*"],
            SMTP_HOST="",
            SMTP_USE_TLS=False,
        )

        with self.assertRaises(RuntimeError) as raised:
            Settings.validate_for_startup(unsafe)

        message = str(raised.exception)
        for expected in ("SECRET_KEY", "DATABASE_URL", "DEBUG", "APP_BASE_URL", "CORS_ORIGINS", "SMTP_HOST"):
            self.assertIn(expected, message)

    def test_noncanonical_production_cors_origins_are_rejected(self):
        unsafe = production_config(CORS_ORIGINS=["https://arrowmatch.com/"])
        with self.assertRaisesRegex(RuntimeError, "CORS_ORIGINS"):
            Settings.validate_for_startup(unsafe)

    def test_production_postgres_connection_requires_tls(self):
        unsafe = production_config(DATABASE_URL="postgresql+psycopg://arrow:secret@db.example/arrowmatch")
        with self.assertRaisesRegex(RuntimeError, "sslmode"):
            Settings.validate_for_startup(unsafe)

    def test_production_rejects_local_sender_and_incomplete_smtp_credentials(self):
        unsafe = production_config(
            EMAIL_FROM="noreply@arrowmatch.local",
            SMTP_USERNAME="arrowmatch",
            SMTP_PASSWORD="",
        )
        with self.assertRaises(RuntimeError) as raised:
            Settings.validate_for_startup(unsafe)
        self.assertIn("EMAIL_FROM", str(raised.exception))
        self.assertIn("SMTP_USERNAME", str(raised.exception))


class RateLimitTests(TestCase):
    def test_forwarded_headers_cannot_bypass_client_rate_limit_and_guest_has_own_bucket(self):
        first = request_from("198.51.100.10", headers=(("X-Real-IP", "spoofed"),))
        retry = request_from("198.51.100.10", headers=(("X-Real-IP", "another-spoof"),))
        other_client = request_from("198.51.100.11", headers=(("X-Forwarded-For", "198.51.100.10"),))
        guest = request_from("198.51.100.10", path="/api/guest")

        with patch.object(deps, "_rate_store", OrderedDict()), \
             patch.object(deps, "_rate_store_last_sweep", 0), \
             patch.object(deps.settings, "AUTH_RATE_LIMIT", 1), \
             patch.object(deps.settings, "GUEST_RATE_LIMIT", 1), \
             patch.object(deps.settings, "AUTH_RATE_WINDOW", 60):
            deps.check_rate_limit(first)
            with self.assertRaises(HTTPException) as raised:
                deps.check_rate_limit(retry)
            self.assertEqual(raised.exception.status_code, 429)
            deps.check_rate_limit(other_client)
            deps.check_rate_limit(guest)
            with self.assertRaises(HTTPException):
                deps.check_rate_limit(guest)

    def test_rate_limit_store_has_a_fixed_capacity(self):
        requests = [request_from(f"198.51.100.{index}") for index in range(1, 5)]
        with patch.object(deps, "_rate_store", OrderedDict()), \
             patch.object(deps, "_rate_store_last_sweep", 0), \
             patch.object(deps, "_RATE_STORE_MAX_KEYS", 2):
            for request in requests:
                deps.check_rate_limit(request)
            self.assertEqual(len(deps._rate_store), 2)


class WebSocketGuardTests(DatabaseTestCase):
    def test_arrow_preview_requires_participant_and_forwards_only_to_opponent(self):
        manager = ConnectionManager()
        manager.register_match_participants("match-1", ["player-1", "player-2"])

        async def verify_routes():
            with patch.object(manager, "notify_user", new=AsyncMock()) as notify_user:
                await manager.notify_match_opponent("match-1", "intruder", {"type": "opp_arrow"})
                notify_user.assert_not_awaited()

                await manager.notify_match_opponent("match-1", "player-1", {"type": "opp_arrow"})
                notify_user.assert_awaited_once_with("player-2", {"type": "opp_arrow"})

        asyncio.run(verify_routes())

    def test_arrow_preview_validation_rejects_bad_indices_values_and_oversize_snapshots(self):
        self.assertTrue(_is_valid_arrow_message({"match_id": "m", "arrow_index": None, "value": None, "arrows": [8, None]}))
        self.assertFalse(_is_valid_arrow_message({"match_id": "m", "arrow_index": 360, "value": 8}))
        self.assertFalse(_is_valid_arrow_message({"match_id": "m", "arrow_index": 0, "value": 11}))
        self.assertFalse(_is_valid_arrow_message({"match_id": "m", "arrow_index": 0, "value": 8, "arrows": [8] * 361}))

    def test_matchmaking_filters_reject_unknown_or_malformed_values(self):
        self.assertEqual(_sanitize_matchmaking_filters({"skill": ["Beginner"]}), {"skill": ["Beginner"]})
        self.assertIsNone(_sanitize_matchmaking_filters({"skill": "Beginner"}))
        self.assertIsNone(_sanitize_matchmaking_filters({"skill": ["admin"]}))

    def test_matchmaking_profile_comes_from_persisted_profile(self):
        user = User(id="profile-user", is_guest=True)
        self.db.add(user)
        self.db.add(Profile(
            user_id=user.id,
            name="Database Archer",
            gender=GenderEnum.female,
            age=AgeEnum.under18,
            bow_type=BowTypeEnum.recurve,
            skill_level=SkillLevelEnum.skilled,
            country="Netherlands",
        ))
        self.db.commit()

        profile_session = self.Session()
        try:
            with patch("ws.routes.SessionLocal", return_value=profile_session):
                profile = _load_matchmaking_profile(user.id)
        finally:
            profile_session.close()

        self.assertEqual(profile["name"], "Database Archer")
        self.assertEqual(profile["bow_type"], BowTypeEnum.recurve.value)
        self.assertEqual(profile["skill_level"], SkillLevelEnum.skilled.value)
