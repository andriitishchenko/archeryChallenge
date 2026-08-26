"""
WebSocket connection manager — single /ws/user architecture.

Every user has exactly one WebSocket (their /ws/user connection).
All server→client events go through notify_user().
All client→server events (arrows, matchmaking) are handled in routes.py
and forwarded to the correct opponent via notify_match_opponent().

Match participant registry: match_id → [user_id, ...]
Populated when matches are created (via challenges/scores routers).
Used to find opponents for arrow broadcasting.
"""
import asyncio
import json
import logging
import uuid
from collections import defaultdict
from typing import Dict, List, Optional

from fastapi import WebSocket

from bots.generator import generate_bot_profile
from core.config import settings

# Max queued offline messages per user — prevents unbounded memory growth
_PENDING_CAP = 50
log = logging.getLogger("arrowmatch.websocket")


def _message_summary(message: dict) -> str:
    """Serialize a WS payload consistently for diagnostics without tokens."""
    return json.dumps(message, ensure_ascii=False, sort_keys=True, default=str)


class ConnectionManager:
    def __init__(self):
        # user_id → WebSocket  (single /ws/user connection per user)
        self._user_sockets: Dict[str, WebSocket] = {}

        # match_id → [user_id, ...]  populated when matches are created
        self._match_participants: Dict[str, List[str]] = defaultdict(list)

        # Pending notifications for offline users — delivered on reconnect
        self._pending: Dict[str, List[dict]] = defaultdict(list)

        # Matchmaking queue: user_id → {ws, filters, profile}
        self._mm_queue: Dict[str, dict] = {}

        # At most one delayed bot fallback may exist for a queued user.
        self._mm_bot_tasks: Dict[str, asyncio.Task] = {}

    # ── User socket registration ──────────────────────────────────────────────

    def register_user_socket(self, user_id: str, ws: WebSocket):
        self._user_sockets[user_id] = ws
        pending = self._pending.pop(user_id, [])
        log.info("WS CONNECT user=%s pending=%d", user_id, len(pending))
        if pending:
            asyncio.create_task(self._flush_pending(user_id, ws, pending))

    def unregister_user_socket(self, user_id: str, ws: WebSocket):
        if self._user_sockets.get(user_id) is ws:
            del self._user_sockets[user_id]
            log.info("WS DISCONNECT user=%s", user_id)

    async def _flush_pending(self, user_id: str, ws: WebSocket, messages: list):
        for msg in messages:
            await self.send_personal(ws, msg, recipient_id=user_id, queued=True)

    # ── Match participant registry ────────────────────────────────────────────

    def register_match_participants(self, match_id: str, user_ids: List[str]):
        """Register participants so notify_match_opponent() works."""
        self._match_participants[match_id] = list(user_ids)

    def ensure_match_registered(self, match_id: str, participants) -> None:
        """
        Lazily register match participants from ORM objects if the in-memory
        registry was lost (server restart).  Call at the start of any endpoint
        that uses notify_match_opponent().
        Accepts a list of MatchParticipant ORM objects.
        """
        if not self._match_participants.get(match_id):
            user_ids = [p.user_id for p in participants if not p.is_bot]
            if user_ids:
                self._match_participants[match_id] = user_ids

    def unregister_match(self, match_id: str):
        self._match_participants.pop(match_id, None)

    # ── Messaging ─────────────────────────────────────────────────────────────

    async def notify_user(self, user_id: str, message: dict):
        """Push a message to a user. Queues if offline (capped at _PENDING_CAP)."""
        ws = self._user_sockets.get(user_id)
        if ws:
            await self.send_personal(ws, message, recipient_id=user_id)
        else:
            queue = self._pending[user_id]
            if len(queue) < _PENDING_CAP:
                queue.append(message)
                log.info(
                    "WS QUEUE user=%s pending=%d type=%s match=%s payload=%s",
                    user_id, len(queue), message.get("type"),
                    message.get("match_id"), _message_summary(message),
                )
            else:
                log.warning("WS QUEUE_FULL user=%s type=%s", user_id, message.get("type"))

    async def notify_users(self, user_ids: List[str], message: dict):
        """Push a message to multiple users."""
        for uid in user_ids:
            await self.notify_user(uid, message)

    async def notify_match_opponent(self, match_id: str, sender_id: str, message: dict):
        """Forward a message from sender to their opponent(s) in a match."""
        recipients = [
            uid for uid in self._match_participants.get(match_id, [])
            if uid != sender_id
        ]
        log.info(
            "WS ROUTE match=%s sender=%s recipients=%s type=%s payload=%s",
            match_id, sender_id, recipients, message.get("type"),
            _message_summary(message),
        )
        for uid in recipients:
            await self.notify_user(uid, message)

    async def notify_match_all(self, match_id: str, message: dict):
        """Send a message to all participants in a match."""
        for uid in self._match_participants.get(match_id, []):
            await self.notify_user(uid, message)

    async def notify_user_disconnected(self, user_id: str):
        """Notify all match opponents that this user disconnected."""
        for match_id, participants in self._match_participants.items():
            if user_id in participants:
                for uid in participants:
                    if uid != user_id:
                        await self.notify_user(uid, {
                            "type":     "opponent_disconnected",
                            "match_id": match_id,
                        })

    async def send_personal(
        self,
        ws: WebSocket,
        message: dict,
        recipient_id: Optional[str] = None,
        queued: bool = False,
    ):
        log.info(
            "WS SEND user=%s queued=%s type=%s match=%s payload=%s",
            recipient_id or "unknown", queued, message.get("type"),
            message.get("match_id"), _message_summary(message),
        )
        try:
            await ws.send_json(message)
        except Exception:
            log.exception(
                "WS SEND_FAILED user=%s type=%s match=%s",
                recipient_id or "unknown", message.get("type"), message.get("match_id"),
            )

    # ── Challenge feed ────────────────────────────────────────────────────────

    async def broadcast_challenge_event(self, event: dict, exclude_user_id: str = None):
        """Broadcast a challenge list event to all connected users."""
        dead = []
        for uid, ws in list(self._user_sockets.items()):
            if uid == exclude_user_id:
                continue
            try:
                log.info(
                    "WS SEND user=%s queued=false type=%s match=%s payload=%s",
                    uid, event.get("type"), event.get("match_id"), _message_summary(event),
                )
                await ws.send_json(event)
            except Exception:
                log.exception("WS BROADCAST_FAILED user=%s type=%s", uid, event.get("type"))
                dead.append(uid)
        for uid in dead:
            self._user_sockets.pop(uid, None)

    # ── Matchmaking ───────────────────────────────────────────────────────────

    async def join_matchmaking(
        self, ws: WebSocket, user_id: str, filters: dict, profile: dict
    ):
        # A reconnect or repeated Find click must replace the previous
        # request instead of leaving multiple delayed bot tasks behind.
        self.leave_matchmaking(user_id)
        self._mm_queue[user_id] = {
            "ws":      ws,
            "filters": filters,
            "profile": profile,
        }
        await self.send_personal(
            ws, {"type": "mm_status", "message": "Searching for opponent…"},
            recipient_id=user_id,
        )

        matched = await self._try_match(user_id)
        if not matched:
            self._mm_bot_tasks[user_id] = asyncio.create_task(
                self._bot_spawn_task(user_id, profile)
            )

    def leave_matchmaking(self, user_id: str):
        self._mm_queue.pop(user_id, None)
        task = self._mm_bot_tasks.pop(user_id, None)
        try:
            current_task = asyncio.current_task()
        except RuntimeError:
            current_task = None
        if task and task is not current_task and not task.done():
            task.cancel()

    async def _try_match(self, requester_id: str) -> bool:
        requester = self._mm_queue.get(requester_id)
        if not requester:
            return False

        for other_id, other in list(self._mm_queue.items()):
            if other_id == requester_id:
                continue
            if (
                _profiles_compatible(requester["filters"], other["profile"])
                and _profiles_compatible(other["filters"], requester["profile"])
            ):
                match_id = str(uuid.uuid4())
                await self.send_personal(requester["ws"], {
                    "type":     "mm_matched",
                    "match_id": match_id,
                    "opponent": _safe_profile(other["profile"]),
                }, recipient_id=requester_id)
                await self.send_personal(other["ws"], {
                    "type":     "mm_matched",
                    "match_id": match_id,
                    "opponent": _safe_profile(requester["profile"]),
                }, recipient_id=other_id)
                self.leave_matchmaking(requester_id)
                self.leave_matchmaking(other_id)
                return True
        return False

    async def _bot_spawn_task(self, user_id: str, user_profile: dict):
        try:
            await asyncio.sleep(settings.BOT_WAIT_SECONDS)

            # Claim the request before the first await. This makes the
            # fallback single-shot even if duplicate tasks were scheduled by
            # older clients or concurrent reconnect messages.
            task = asyncio.current_task()
            if (
                user_id not in self._mm_queue
                or self._mm_bot_tasks.get(user_id) is not task
            ):
                return
            ws = self._user_sockets.get(user_id)
            if not ws:
                self.leave_matchmaking(user_id)
                return
            self._mm_queue.pop(user_id, None)
            self._mm_bot_tasks.pop(user_id, None)

            skill    = user_profile.get("skill_level", "Skilled")
            bow      = user_profile.get("bow_type", "Recurve")
            bot      = generate_bot_profile(skill, bow)
            match_id = str(uuid.uuid4())
            await self.send_personal(ws, {
                "type":     "mm_matched",
                "match_id": match_id,
                "is_bot":   True,
                "opponent": _safe_profile(bot),
            }, recipient_id=user_id)
        except asyncio.CancelledError:
            return


# Module-level singleton
manager = ConnectionManager()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_profile(profile: dict) -> dict:
    return {k: v for k, v in profile.items() if k != "is_bot"}


def _profiles_compatible(filters: dict, profile: dict) -> bool:
    if filters.get("skill") and profile.get("skill_level") not in filters["skill"]:
        return False
    if filters.get("gender") and profile.get("gender") not in filters["gender"]:
        return False
    if filters.get("bow") and profile.get("bow_type") not in filters["bow"]:
        return False
    if filters.get("country") and filters["country"] and profile.get("country") != filters["country"]:
        return False
    return True
