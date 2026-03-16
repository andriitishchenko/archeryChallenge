"""
Background task: challenge/match expiry.
Runs every EXPIRY_CHECK_INTERVAL_SECONDS.

Rules:
  1. Scheduled challenges past deadline with no active match → mark inactive.
  2. Active matches where one side submitted but opponent didn't within
     MATCH_INACTIVITY_SECONDS → forfeit the inactive player.
  3. Completely stale matches (no activity since creation) → cancel as draw.
"""
import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session, joinedload

from core.config import settings
from models.database import SessionLocal
from models.models import Challenge, Match, MatchParticipant, MatchResultEnum, Profile
from ws.manager import manager

log = logging.getLogger(__name__)

_task: asyncio.Task | None = None


def start_expiry_task() -> None:
    global _task
    _task = asyncio.create_task(_expiry_loop())
    log.info("Expiry task started.")


def stop_expiry_task() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()


async def _expiry_loop() -> None:
    while True:
        try:
            await asyncio.sleep(settings.EXPIRY_CHECK_INTERVAL_SECONDS)
            await _run_expiry()
        except asyncio.CancelledError:
            break
        except Exception as exc:
            log.exception("Expiry task error: %s", exc)


async def _run_expiry() -> None:
    db: Session = SessionLocal()
    try:
        now = datetime.utcnow()

        # 1. Expire past-deadline challenges with no active match
        for ch in (
            db.query(Challenge)
            .filter(Challenge.is_active == True, Challenge.deadline.isnot(None), Challenge.deadline < now)
            .all()
        ):
            if not any(m.status != "complete" for m in ch.matches):
                ch.is_active = False
                log.info("Challenge %s expired (past deadline).", ch.id)
                await manager.notify_user(ch.creator_id, {
                    "type": "challenge_expired", "challenge_id": ch.id,
                    "reason": "No opponent joined before the deadline.", "you_lost": False,
                })
                if not ch.is_private:
                    await manager.broadcast_challenge_event({
                        "type": "challenge_removed", "challenge_id": ch.id,
                    })
        db.flush()

        # 2. Expire stale active matches
        cutoff = now - timedelta(seconds=settings.MATCH_INACTIVITY_SECONDS)
        for match in (
            db.query(Match)
            .options(joinedload(Match.participants), joinedload(Match.challenge))
            .filter(Match.status == "active")
            .all()
        ):
            human     = [p for p in match.participants if not p.is_bot]
            if len(human) < 2:
                continue
            submitted = [p for p in human if p.submitted_at is not None]
            pending   = [p for p in human if p.submitted_at is None]

            if not submitted:
                if match.created_at < cutoff:
                    for p in human:
                        p.result = MatchResultEnum.draw
                    match.status = "complete"
                    match.completed_at = now
                    log.info("Match %s expired (no activity).", match.id)
                    await _notify_expiry(match, human, None, db)
            elif pending:
                if min(p.submitted_at for p in submitted) < cutoff:
                    for p in pending:
                        p.result = MatchResultEnum.loss
                    for p in submitted:
                        p.result = MatchResultEnum.win
                    match.status = "complete"
                    match.completed_at = now
                    log.info("Match %s expired: %d player(s) timed out.", match.id, len(pending))
                    await _notify_expiry(match, human, pending, db)

        db.commit()
    except Exception as exc:
        db.rollback()
        log.exception("Error in _run_expiry: %s", exc)
    finally:
        db.close()


async def _notify_expiry(match: Match, human: list, forfeited: list | None, db: Session) -> None:
    forfeited_ids = {p.user_id for p in forfeited} if forfeited else set()
    for p in human:
        you_lost = p.user_id in forfeited_ids if forfeited else False
        reason = (
            "You did not submit your score in time — forfeit."
            if you_lost else
            "Your opponent did not submit their score in time — you win!"
        ) if forfeited else "Match expired due to inactivity."
        await manager.notify_user(p.user_id, {
            "type": "challenge_expired", "match_id": match.id,
            "you_lost": you_lost, "reason": reason,
        })
