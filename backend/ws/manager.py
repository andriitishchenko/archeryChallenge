"""
WebSocket connection manager.
NOTE: ws.accept() is called in the route handler BEFORE these methods.
      These methods only store/remove sockets and send messages.
"""
import asyncio
import uuid
from typing import Dict, List, Optional
from collections import defaultdict

from fastapi import WebSocket

from bots.generator import generate_bot_profile
from core.config import settings


class ConnectionManager:
    def __init__(self):
        # match_id -> list[WebSocket]
        self._match_connections: Dict[str, List[WebSocket]] = defaultdict(list)
        # user_id -> WebSocket  (latest active match socket for that user)
        self._user_sockets: Dict[str, WebSocket] = {}
        # challenge_id -> WebSocket  (creator waiting for opponent on their challenge)
        self._challenge_creator_sockets: Dict[str, WebSocket] = {}
        # user_id -> challenge_id  (reverse index for cleanup on disconnect)
        self._creator_challenge_map: Dict[str, str] = {}
        # All WebSockets subscribed to the public challenges feed
        self._challenge_feed: List[WebSocket] = []
        # user_id -> {ws, filters, profile, joined_at}
        self._matchmaking_queue: Dict[str, dict] = {}
        # user_id -> WebSocket
        self._matchmaking_sockets: Dict[str, WebSocket] = {}

    # ── Match connections ─────────────────────────────────────────────────────

    def register_match(self, match_id: str, ws: WebSocket, user_id: str):
        """Register an already-accepted WebSocket for a live match."""
        self._match_connections[match_id].append(ws)
        # Track user → ws so REST endpoints can push notifications
        self._user_sockets[user_id] = ws

    def disconnect_match(self, match_id: str, ws: WebSocket):
        conns = self._match_connections.get(match_id, [])
        if ws in conns:
            conns.remove(ws)
        # Remove from user_sockets if it matches
        dead = [uid for uid, w in self._user_sockets.items() if w is ws]
        for uid in dead:
            del self._user_sockets[uid]

    # ── Challenge feed (public list realtime updates) ─────────────────────────

    def register_challenge_feed(self, ws: WebSocket):
        """Subscribe a client to the public challenge-list feed."""
        if ws not in self._challenge_feed:
            self._challenge_feed.append(ws)

    def unregister_challenge_feed(self, ws: WebSocket):
        if ws in self._challenge_feed:
            self._challenge_feed.remove(ws)

    async def broadcast_challenge_event(self, event: dict, exclude_user_id: str = None):
        """Broadcast a challenge event (new_challenge, challenge_removed) to all feed subscribers."""
        dead = []
        for ws in list(self._challenge_feed):
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unregister_challenge_feed(ws)

    # ── Creator waiting socket (creator listens for opponent_joined) ──────────

    def register_creator_waiting(self, challenge_id: str, user_id: str, ws: WebSocket):
        """
        Register the creator's WS as listening for opponent on a specific challenge.
        Also registers in _user_sockets so notify_user() can reach them.
        """
        self._challenge_creator_sockets[challenge_id] = ws
        self._creator_challenge_map[user_id] = challenge_id
        self._user_sockets[user_id] = ws

    def unregister_creator_waiting(self, challenge_id: str, ws: WebSocket):
        if self._challenge_creator_sockets.get(challenge_id) is ws:
            del self._challenge_creator_sockets[challenge_id]
        dead_users = [uid for uid, cid in self._creator_challenge_map.items()
                      if cid == challenge_id]
        for uid in dead_users:
            del self._creator_challenge_map[uid]
            # Clean up user_sockets too if it points to this ws
            if self._user_sockets.get(uid) is ws:
                del self._user_sockets[uid]

    async def notify_user(self, user_id: str, message: dict):
        """Push a message to a specific user's active match WebSocket (if connected)."""
        ws = self._user_sockets.get(user_id)
        if ws:
            await self.send_personal(ws, message)

    async def broadcast_match(
        self, match_id: str, message: dict, exclude: Optional[WebSocket] = None
    ):
        """Send a JSON message to all connected players in a match except `exclude`."""
        dead = []
        for ws in list(self._match_connections.get(match_id, [])):
            if ws is exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect_match(match_id, ws)

    async def send_personal(self, ws: WebSocket, message: dict):
        """Send a JSON message to a single already-accepted WebSocket."""
        try:
            await ws.send_json(message)
        except Exception:
            pass

    # ── Matchmaking ───────────────────────────────────────────────────────────

    async def join_matchmaking(
        self, ws: WebSocket, user_id: str, filters: dict, profile: dict
    ):
        """
        Add user to matchmaking queue.
        ws is already accepted by the route handler — do NOT call ws.accept() here.
        """
        self._matchmaking_queue[user_id] = {
            "ws": ws,
            "filters": filters,
            "profile": profile,
            "joined_at": asyncio.get_event_loop().time(),
        }
        self._matchmaking_sockets[user_id] = ws

        await self.send_personal(ws, {"type": "status", "message": "Searching for opponent…"})

        matched = await self._try_match(user_id)
        if not matched:
            asyncio.create_task(self._bot_spawn_task(user_id, profile))

    def leave_matchmaking(self, user_id: str):
        self._matchmaking_queue.pop(user_id, None)
        self._matchmaking_sockets.pop(user_id, None)

    async def _try_match(self, requester_id: str) -> bool:
        """Attempt to pair requester with another waiting user."""
        requester = self._matchmaking_queue.get(requester_id)
        if not requester:
            return False

        for other_id, other in list(self._matchmaking_queue.items()):
            if other_id == requester_id:
                continue
            if (
                _profiles_compatible(requester["filters"], other["profile"])
                and _profiles_compatible(other["filters"], requester["profile"])
            ):
                match_id = str(uuid.uuid4())
                await self.send_personal(requester["ws"], {
                    "type": "matched",
                    "match_id": match_id,
                    "opponent": _safe_profile(other["profile"]),
                })
                await self.send_personal(other["ws"], {
                    "type": "matched",
                    "match_id": match_id,
                    "opponent": _safe_profile(requester["profile"]),
                })
                self.leave_matchmaking(requester_id)
                self.leave_matchmaking(other_id)
                return True
        return False

    async def _bot_spawn_task(self, user_id: str, user_profile: dict):
        """After BOT_WAIT_SECONDS, spawn a bot if the user is still waiting."""
        await asyncio.sleep(settings.BOT_WAIT_SECONDS)

        if user_id not in self._matchmaking_queue:
            return  # already matched or cancelled

        ws = self._matchmaking_sockets.get(user_id)
        if not ws:
            return

        skill = user_profile.get("skill_level", "Skilled")
        bow   = user_profile.get("bow_type", "Recurve")
        bot   = generate_bot_profile(skill, bow)
        match_id = str(uuid.uuid4())

        await self.send_personal(ws, {
            "type": "matched",
            "match_id": match_id,
            "opponent": _safe_profile(bot),  # is_bot stripped — client never sees it
        })
        self.leave_matchmaking(user_id)


# Module-level singleton
manager = ConnectionManager()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_profile(profile: dict) -> dict:
    """Remove internal-only fields before sending to the client."""
    return {k: v for k, v in profile.items() if k not in ("is_bot",)}


def _profiles_compatible(filters: dict, profile: dict) -> bool:
    """Return True if profile satisfies the given filter set."""
    if filters.get("skill") and profile.get("skill_level") not in filters["skill"]:
        return False
    if filters.get("gender") and profile.get("gender") not in filters["gender"]:
        return False
    if filters.get("bow") and profile.get("bow_type") not in filters["bow"]:
        return False
    if filters.get("country") and filters["country"] and profile.get("country") != filters["country"]:
        return False
    return True
