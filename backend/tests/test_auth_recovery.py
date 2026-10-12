from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from fastapi import HTTPException

from core.security import generate_password_reset_token, hash_password, hash_password_reset_token, verify_password
from models.models import PasswordResetToken, User
from routers import auth
from schemas.auth import ForgotPasswordRequest, ResetPasswordRequest

from support import DatabaseTestCase


class PasswordRecoveryTests(DatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.user = User(
            id="registered-1",
            email="archer@example.com",
            hashed_password=hash_password("old-password-1"),
            is_guest=False,
        )
        self.db.add(self.user)
        self.db.commit()

    def test_reset_link_is_hashed_one_time_and_unknown_addresses_get_same_response(self):
        with patch.object(auth, "send_password_reset_email") as send_email:
            known_response = auth.forgot_password(ForgotPasswordRequest(email=self.user.email), self.db)
            unknown_response = auth.forgot_password(ForgotPasswordRequest(email="unknown@example.com"), self.db)

        self.assertEqual(known_response.message, unknown_response.message)
        send_email.assert_called_once()
        reset_url = send_email.call_args.args[1]
        parsed_reset_url = urlparse(reset_url)
        self.assertNotIn("reset_token", parsed_reset_url.query)
        raw_token = parse_qs(parsed_reset_url.fragment)["reset_token"][0]
        stored = self.db.query(PasswordResetToken).filter_by(user_id=self.user.id).one()
        self.assertEqual(stored.token_hash, hash_password_reset_token(raw_token))
        self.assertNotEqual(stored.token_hash, raw_token)

        response = auth.reset_password(
            ResetPasswordRequest(token=raw_token, password="new-password-2"),
            self.db,
        )
        self.db.refresh(self.user)
        self.assertIn("reset", response.message.lower())
        self.assertTrue(verify_password("new-password-2", self.user.hashed_password))
        self.assertIsNotNone(stored.used_at)

        with self.assertRaises(HTTPException) as raised:
            auth.reset_password(
                ResetPasswordRequest(token=raw_token, password="another-password-3"),
                self.db,
            )
        self.assertEqual(raised.exception.status_code, 400)

    def test_new_reset_request_invalidates_the_previous_link(self):
        with patch.object(auth, "send_password_reset_email") as send_email:
            auth.forgot_password(ForgotPasswordRequest(email=self.user.email), self.db)
            first_url = send_email.call_args.args[1]
            auth.forgot_password(ForgotPasswordRequest(email=self.user.email), self.db)
            second_url = send_email.call_args.args[1]

        first_token = parse_qs(urlparse(first_url).fragment)["reset_token"][0]
        second_token = parse_qs(urlparse(second_url).fragment)["reset_token"][0]
        self.assertNotEqual(first_token, second_token)
        with self.assertRaises(HTTPException):
            auth.reset_password(ResetPasswordRequest(token=first_token, password="new-password-2"), self.db)
        auth.reset_password(ResetPasswordRequest(token=second_token, password="new-password-2"), self.db)

    def test_expired_reset_token_is_rejected_without_changing_password(self):
        raw_token = generate_password_reset_token()
        self.db.add(PasswordResetToken(
            user_id=self.user.id,
            token_hash=hash_password_reset_token(raw_token),
            expires_at=datetime.utcnow() - timedelta(seconds=1),
        ))
        self.db.commit()

        with self.assertRaises(HTTPException) as raised:
            auth.reset_password(
                ResetPasswordRequest(token=raw_token, password="new-password-2"),
                self.db,
            )

        self.assertEqual(raised.exception.status_code, 400)
        self.db.refresh(self.user)
        self.assertTrue(verify_password("old-password-1", self.user.hashed_password))
