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
        # user_id -> {ws, filters, profile, joined_at}
        self._matchmaking_queue: Dict[str, dict] = {}
        # user_id -> WebSocket
        self._matchmaking_sockets: Dict[str, WebSocket] = {}

    # ── Match connections ─────────────────────────────────────────────────────

    def register_match(self, match_id: str, ws: WebSocket, user_id: str):
        """Register an already-accepted WebSocket for a live match."""
        self._match_connections[match_id].append(ws)

    def disconnect_match(self, match_id: str, ws: WebSocket):
        conns = self._match_connections.get(match_id, [])
        if ws in conns:
            conns.remove(ws)

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
