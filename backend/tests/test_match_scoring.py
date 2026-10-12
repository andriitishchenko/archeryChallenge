import asyncio
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from models.models import (
    ArrowScore,
    Challenge,
    ChallengeKindEnum,
    DisciplineEnum,
    Match,
    MatchParticipant,
    MatchResultEnum,
    MatchTypeEnum,
    ScoringEnum,
    User,
)
from routers import matches
from schemas.matches import ArrowScoreItem, ScoreSubmission, SetSubmission
from services.match import MAX_ACTIVE_MATCHES_PER_USER, count_set_points, ensure_active_match_capacity

from support import DatabaseTestCase


class MatchScoringTests(DatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.first = User(id="first-user", is_guest=True)
        self.second = User(id="second-user", is_guest=True)
        self.db.add_all([self.first, self.second])
        self.db.commit()

    def add_match(self, match_id, scoring, status="active", parent=None):
        challenge = Challenge(
            id=f"challenge-{match_id}",
            creator_id=self.first.id,
            challenge_kind=ChallengeKindEnum.normal,
            match_type=MatchTypeEnum.live,
            discipline=DisciplineEnum.target,
            scoring=scoring,
            distance="30m",
            arrow_count=18 if scoring == ScoringEnum.total else None,
            is_active=True,
        )
        match = Match(
            id=match_id,
            challenge=challenge,
            status=status,
            parent_match_id=parent.id if parent else None,
            first_to_act=self.first.id,
        )
        match.participants.extend([
            MatchParticipant(user_id=self.first.id, is_creator=True),
            MatchParticipant(user_id=self.second.id, is_creator=False),
        ])
        self.db.add(match)
        self.db.commit()
        return match

    @staticmethod
    def total_submission(value):
        return ScoreSubmission(arrows=[ArrowScoreItem(arrow_index=i, value=value) for i in range(18)])

    def test_total_scores_resolve_winner_after_both_players_submit(self):
        match = self.add_match("total-win", ScoringEnum.total)

        with patch.object(matches.manager, "notify_user", new=AsyncMock()), \
             patch.object(matches.manager, "notify_match_opponent", new=AsyncMock()):
            first_result = asyncio.run(matches.submit_score(match.id, self.total_submission(7), self.first, self.db))
            second_result = asyncio.run(matches.submit_score(match.id, self.total_submission(8), self.second, self.db))

        self.db.refresh(match)
        self.assertFalse(first_result["match_complete"])
        self.assertTrue(second_result["match_complete"])
        self.assertEqual(match.status, "complete")
        results = {participant.user_id: participant.result for participant in match.participants}
        self.assertEqual(results[self.first.id], MatchResultEnum.loss)
        self.assertEqual(results[self.second.id], MatchResultEnum.win)

    def test_equal_total_scores_create_one_linked_tiebreak_match(self):
        match = self.add_match("total-tie", ScoringEnum.total)

        with patch.object(matches, "notify_tiebreak_started"):
            asyncio.run(matches.submit_score(match.id, self.total_submission(8), self.first, self.db))
            response = asyncio.run(matches.submit_score(match.id, self.total_submission(8), self.second, self.db))

        self.assertTrue(response["tiebreak_required"])
        children = self.db.query(Match).filter_by(parent_match_id=match.id).all()
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0].challenge.arrow_count, 1)
        self.assertEqual(match.status, "active")

    def test_set_result_awards_points_and_sets_next_first_archer(self):
        match = self.add_match("set-resolution", ScoringEnum.sets)

        with patch.object(matches.manager, "notify_user", new=AsyncMock()), \
             patch.object(matches.manager, "notify_match_opponent", new=AsyncMock()), \
             patch.object(matches.manager, "notify_match_all", new=AsyncMock()):
            first_result = asyncio.run(matches.submit_set(match.id, SetSubmission(set_number=1, arrows=[9, 8, 8]), self.first, self.db))
            second_result = asyncio.run(matches.submit_set(match.id, SetSubmission(set_number=1, arrows=[7, 7, 7]), self.second, self.db))

        self.db.refresh(match)
        self.assertFalse(first_result.both_submitted)
        self.assertTrue(second_result.both_submitted)
        self.assertEqual(second_result.my_set_points, 0)
        self.assertEqual(second_result.opp_set_points, 2)
        self.assertEqual(match.first_to_act, self.second.id)

    def test_set_points_ignore_incomplete_sets_and_sudden_death_arrows(self):
        match = self.add_match("set-points", ScoringEnum.sets)
        first, second = match.participants
        self.db.add_all([
            ArrowScore(participant_id=first.id, arrow_index=10, value=8, set_number=1),
            ArrowScore(participant_id=second.id, arrow_index=10, value=8, set_number=1),
            ArrowScore(participant_id=first.id, arrow_index=20, value=10, set_number=2),
            ArrowScore(participant_id=first.id, arrow_index=0, value=10, set_number=0),
        ])
        self.db.commit()

        self.assertEqual(count_set_points(first, match.id, self.db), 1)
        self.assertEqual(count_set_points(second, match.id, self.db), 1)

    def test_active_match_limit_excludes_tiebreak_children(self):
        parents = [self.add_match(f"parent-{i}", ScoringEnum.total) for i in range(MAX_ACTIVE_MATCHES_PER_USER - 1)]
        for index in range(3):
            self.add_match(f"child-{index}", ScoringEnum.total, parent=parents[0])

        ensure_active_match_capacity([self.first.id], self.db)
        self.add_match("tenth-parent", ScoringEnum.total)
        with self.assertRaises(HTTPException) as raised:
            ensure_active_match_capacity([self.first.id], self.db)
        self.assertEqual(raised.exception.status_code, 409)
