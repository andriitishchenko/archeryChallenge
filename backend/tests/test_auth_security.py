from fastapi import HTTPException

from core.deps import get_current_user_id
from core.security import create_access_token, create_refresh_token, get_user_id_from_token
from models.models import User
from routers import auth
from schemas.auth import RegisterRequest

from support import DatabaseTestCase


class AuthSecurityTests(DatabaseTestCase):
    def test_access_token_authenticates_but_refresh_token_does_not(self):
        access = create_access_token("user-1")
        refresh = create_refresh_token("user-1")

        self.assertEqual(get_user_id_from_token(access), "user-1")
        self.assertIsNone(get_user_id_from_token(refresh))
        with self.assertRaises(HTTPException) as raised:
            get_current_user_id(f"Bearer {refresh}")
        self.assertEqual(raised.exception.status_code, 401)

    def test_guest_upgrade_requires_authenticated_matching_guest(self):
        guest = User(id="guest-1", is_guest=True)
        self.db.add(guest)
        self.db.commit()

        with self.assertRaises(HTTPException) as raised:
            auth.register(
                RegisterRequest(email="new@example.com", password="strong-pass-1", existing_user_id=guest.id),
                current_user=None,
                db=self.db,
            )

        self.assertEqual(raised.exception.status_code, 401)
        self.db.refresh(guest)
        self.assertTrue(guest.is_guest)
        self.assertIsNone(guest.email)

    def test_guest_upgrade_rejects_a_different_authenticated_user(self):
        guest = User(id="guest-1", is_guest=True)
        other = User(id="other-1", is_guest=True)
        self.db.add_all([guest, other])
        self.db.commit()

        with self.assertRaises(HTTPException) as raised:
            auth.register(
                RegisterRequest(email="new@example.com", password="strong-pass-1", existing_user_id=guest.id),
                current_user=other,
                db=self.db,
            )

        self.assertEqual(raised.exception.status_code, 403)
        self.db.refresh(guest)
        self.assertTrue(guest.is_guest)
        self.assertIsNone(guest.email)

    def test_guest_upgrade_cannot_replace_a_registered_account(self):
        account = User(
            id="account-1",
            email="owner@example.com",
            hashed_password="existing-hash",
            is_guest=False,
        )
        self.db.add(account)
        self.db.commit()

        with self.assertRaises(HTTPException) as raised:
            auth.register(
                RegisterRequest(email="attacker@example.com", password="attacker-pass", existing_user_id=account.id),
                current_user=account,
                db=self.db,
            )

        self.assertEqual(raised.exception.status_code, 400)
        self.db.refresh(account)
        self.assertEqual(account.email, "owner@example.com")
        self.assertEqual(account.hashed_password, "existing-hash")

    def test_matching_guest_can_upgrade_and_keep_the_same_identity(self):
        guest = User(id="guest-1", is_guest=True)
        self.db.add(guest)
        self.db.commit()

        response = auth.register(
            RegisterRequest(email="new@example.com", password="strong-pass-1", existing_user_id=guest.id),
            current_user=guest,
            db=self.db,
        )

        self.assertEqual(response.user_id, guest.id)
        self.assertFalse(response.is_guest)
        self.db.refresh(guest)
        self.assertEqual(guest.email, "new@example.com")
        self.assertFalse(guest.is_guest)
