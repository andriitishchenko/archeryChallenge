import asyncio
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from models.models import (
    Challenge,
    ChallengeKindEnum,
    DisciplineEnum,
    Match,
    MatchParticipant,
    MatchTypeEnum,
    ScoringEnum,
    User,
)
from routers import matches, rematch
from schemas.matches import ArrowScoreItem, ScoreSubmission, SetSubmission

from support import DatabaseTestCase


class MatchGuardTests(DatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.first = User(id="first-user", is_guest=True)
        self.second = User(id="second-user", is_guest=True)
        self.db.add_all([self.first, self.second])
        self.db.commit()

    def add_match(self, match_id, scoring, status="active", kind=ChallengeKindEnum.normal):
        challenge = Challenge(
            id=f"challenge-{match_id}",
            creator_id=self.first.id,
            challenge_kind=kind,
            match_type=MatchTypeEnum.live,
            discipline=DisciplineEnum.target,
            scoring=scoring,
            distance="30m",
            arrow_count=18 if scoring == ScoringEnum.total else None,
            is_private=kind != ChallengeKindEnum.normal,
            is_active=True,
        )
        match = Match(
            id=match_id,
            challenge=challenge,
            status=status,
            first_to_act=self.first.id,
        )
        match.participants.extend([
            MatchParticipant(user_id=self.first.id, is_creator=True),
            MatchParticipant(user_id=self.second.id, is_creator=False),
        ])
        self.db.add(match)
        self.db.commit()
        return match

    def test_waiting_rematch_rejects_total_score_submission(self):
        self.add_match("waiting-total", ScoringEnum.total, status="waiting", kind=ChallengeKindEnum.rematch)
        submission = ScoreSubmission(arrows=[ArrowScoreItem(arrow_index=i, value=8) for i in range(18)])

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(matches.submit_score("waiting-total", submission, self.first, self.db))

        self.assertEqual(raised.exception.status_code, 409)

    def test_match_status_does_not_disclose_waiting_match_to_nonparticipant(self):
        self.add_match("waiting-private", ScoringEnum.total, status="waiting", kind=ChallengeKindEnum.rematch)
        outsider = User(id="outsider", is_guest=True)
        self.db.add(outsider)
        self.db.commit()

        with self.assertRaises(HTTPException) as raised:
            matches.get_match_status("waiting-private", outsider, self.db)

        self.assertEqual(raised.exception.status_code, 403)

    def test_match_status_rehydrates_participants_for_websocket_delivery(self):
        match = self.add_match("active-status", ScoringEnum.total)
        matches.manager.unregister_match(match.id)
        try:
            response = matches.get_match_status(match.id, self.first, self.db)
            self.assertEqual(response.status, "active")
            self.assertEqual(
                set(matches.manager._match_participants[match.id]),
                {self.first.id, self.second.id},
            )
        finally:
            matches.manager.unregister_match(match.id)

    def test_total_endpoint_rejects_set_scoring_match(self):
        self.add_match("active-sets", ScoringEnum.sets)
        submission = ScoreSubmission(arrows=[ArrowScoreItem(arrow_index=i, value=8) for i in range(3)])

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(matches.submit_score("active-sets", submission, self.first, self.db))

        self.assertEqual(raised.exception.status_code, 400)

    def test_set_endpoint_rejects_total_scoring_match(self):
        self.add_match("active-total", ScoringEnum.total)

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(matches.submit_set("active-total", SetSubmission(set_number=1, arrows=[8, 8, 8]), self.first, self.db))

        self.assertEqual(raised.exception.status_code, 400)

    def test_waiting_rematch_rejects_set_submission(self):
        self.add_match("waiting-sets", ScoringEnum.sets, status="waiting", kind=ChallengeKindEnum.rematch)

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(matches.submit_set("waiting-sets", SetSubmission(set_number=1, arrows=[8, 8, 8]), self.first, self.db))

        self.assertEqual(raised.exception.status_code, 409)

    def test_waiting_rematch_cannot_be_forfeited(self):
        self.add_match("waiting-forfeit", ScoringEnum.total, status="waiting", kind=ChallengeKindEnum.rematch)

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(matches.forfeit_match("waiting-forfeit", self.first, self.db))

        self.assertEqual(raised.exception.status_code, 409)

    def test_proposer_cannot_accept_or_decline_own_rematch(self):
        self.add_match("waiting-rematch", ScoringEnum.total, status="waiting", kind=ChallengeKindEnum.rematch)

        with self.assertRaises(HTTPException) as accept_error:
            asyncio.run(rematch.accept_rematch("waiting-rematch", self.first, self.db))
        with self.assertRaises(HTTPException) as decline_error:
            asyncio.run(rematch.decline_rematch("waiting-rematch", self.first, self.db))

        self.assertEqual(accept_error.exception.status_code, 403)
        self.assertEqual(decline_error.exception.status_code, 403)

    def test_opponent_can_accept_rematch(self):
        waiting = self.add_match("waiting-accept", ScoringEnum.total, status="waiting", kind=ChallengeKindEnum.rematch)

        async def no_op(*args, **kwargs):
            return None

        with patch.object(rematch.manager, "notify_user", new=AsyncMock(side_effect=no_op)):
            response = asyncio.run(rematch.accept_rematch(waiting.id, self.second, self.db))

        self.assertEqual(response.status, "accepted")
        self.db.refresh(waiting)
        self.assertEqual(waiting.status, "active")

    def test_active_match_accepts_correct_scoring_endpoint(self):
        self.add_match("active-total-ok", ScoringEnum.total)
        submission = ScoreSubmission(arrows=[ArrowScoreItem(arrow_index=i, value=8) for i in range(18)])

        with patch.object(matches.manager, "notify_user", new=AsyncMock()), \
             patch.object(matches.manager, "notify_match_opponent", new=AsyncMock()):
            response = asyncio.run(matches.submit_score("active-total-ok", submission, self.first, self.db))

        self.assertEqual(response["status"], "submitted")
        self.assertFalse(response["match_complete"])

    def test_score_schema_rejects_duplicate_arrow_indices(self):
        with self.assertRaises(ValidationError):
            ScoreSubmission(arrows=[
                ArrowScoreItem(arrow_index=0, value=10),
                ArrowScoreItem(arrow_index=0, value=10),
            ])

    def test_total_score_requires_every_configured_arrow_index(self):
        self.add_match("sparse-total", ScoringEnum.total)
        submission = ScoreSubmission(arrows=[ArrowScoreItem(arrow_index=i, value=8) for i in range(1, 19)])

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(matches.submit_score("sparse-total", submission, self.first, self.db))

        self.assertEqual(raised.exception.status_code, 400)

    def test_total_score_retry_is_idempotent_but_cannot_change_values(self):
        self.add_match("immutable-total", ScoringEnum.total)
        original = ScoreSubmission(arrows=[ArrowScoreItem(arrow_index=i, value=8) for i in range(18)])
        changed = ScoreSubmission(arrows=[ArrowScoreItem(arrow_index=i, value=9) for i in range(18)])

        with patch.object(matches.manager, "notify_user", new=AsyncMock()), \
             patch.object(matches.manager, "notify_match_opponent", new=AsyncMock()):
            first_response = asyncio.run(matches.submit_score("immutable-total", original, self.first, self.db))
            retry_response = asyncio.run(matches.submit_score("immutable-total", original, self.first, self.db))
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(matches.submit_score("immutable-total", changed, self.first, self.db))

        self.assertEqual(first_response["status"], "submitted")
        self.assertEqual(retry_response["status"], "submitted")
        self.assertEqual(raised.exception.status_code, 409)

    def test_set_retry_is_idempotent_but_cannot_change_values(self):
        self.add_match("immutable-set", ScoringEnum.sets)
        original = SetSubmission(set_number=1, arrows=[8, 7, 9])
        changed = SetSubmission(set_number=1, arrows=[10, 10, 10])

        with patch.object(matches.manager, "notify_user", new=AsyncMock()), \
             patch.object(matches.manager, "notify_match_opponent", new=AsyncMock()):
            first_response = asyncio.run(matches.submit_set("immutable-set", original, self.first, self.db))
            retry_response = asyncio.run(matches.submit_set("immutable-set", original, self.first, self.db))
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(matches.submit_set("immutable-set", changed, self.first, self.db))

        self.assertFalse(first_response.both_submitted)
        self.assertFalse(retry_response.both_submitted)
        self.assertEqual(raised.exception.status_code, 409)

    def test_set_tiebreak_arrow_cannot_be_changed_after_submission(self):
        match = self.add_match("immutable-tiebreak", ScoringEnum.sets)
        first_participant = next(participant for participant in match.participants if participant.user_id == self.first.id)
        second_participant = next(participant for participant in match.participants if participant.user_id == self.second.id)
        first_participant.final_score = 5
        second_participant.final_score = 5
        self.db.commit()

        asyncio.run(matches.submit_set("immutable-tiebreak", SetSubmission(set_number=0, arrows=[8]), self.first, self.db))
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(matches.submit_set("immutable-tiebreak", SetSubmission(set_number=0, arrows=[9]), self.first, self.db))

        self.assertEqual(raised.exception.status_code, 409)
