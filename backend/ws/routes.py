"""
WebSocket endpoints:
  WS /ws/match/{match_id}?token=...   — live match real-time updates
  WS /ws/matchmaking?token=...        — matchmaking queue
"""
import json
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from core.security import get_user_id_from_token
from ws.manager import manager

router = APIRouter(tags=["websocket"])


async def _auth_and_accept(websocket: WebSocket, token: Optional[str]) -> Optional[str]:
    """Accept FIRST (required before any send/close), then validate token."""
    await websocket.accept()
    user_id = get_user_id_from_token(token) if token else None
    if not user_id:
        await websocket.close(code=4001, reason="Unauthorized")
        return None
    return user_id


@router.websocket("/ws/match/{match_id}")
async def ws_match(
    websocket: WebSocket,
    match_id: str,
    token: Optional[str] = Query(None),
):
    """
    Live match WebSocket. Used for real-time arrow display and set/match notifications.

    Client → server:
      {"type": "ping"}
      {"type": "arrow",          "arrow_index": N, "value": V}      ← live preview only
      {"type": "set_submitted",  "set_number": N}                   ← I just submitted a set
      {"type": "score_submitted"}                                    ← I submitted all arrows (total)
      {"type": "tiebreak_submitted", "set_number": 0}               ← sudden-death submitted

    Server → client (broadcast to opponent):
      {"type": "pong"}
      {"type": "opp_arrow",      "arrow_index": N, "value": V}      ← opponent real-time arrow
      {"type": "opp_set_done",   "set_number": N}                   ← opponent submitted their set
      {"type": "opp_score_done"}                                     ← opponent submitted total score
      {"type": "opp_tiebreak_done"}                                  ← opponent submitted tiebreak
      {"type": "opponent_disconnected"}
    """
    user_id = await _auth_and_accept(websocket, token)
    if not user_id:
        return

    manager.register_match(match_id, websocket, user_id)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            t = msg.get("type")

            if t == "ping":
                await manager.send_personal(websocket, {"type": "pong"})

            elif t == "arrow":
                # Live arrow preview — relay to opponent for real-time display
                await manager.broadcast_match(match_id, {
                    "type": "opp_arrow",
                    "arrow_index": msg.get("arrow_index"),
                    "value": msg.get("value"),
                }, exclude=websocket)

            elif t == "set_submitted":
                # Notify opponent that I submitted my set so they know result is ready
                await manager.broadcast_match(match_id, {
                    "type": "opp_set_done",
                    "set_number": msg.get("set_number"),
                }, exclude=websocket)

            elif t == "score_submitted":
                # Notify opponent that I submitted all arrows (total mode)
                await manager.broadcast_match(match_id, {
                    "type": "opp_score_done",
                }, exclude=websocket)

            elif t == "tiebreak_submitted":
                await manager.broadcast_match(match_id, {
                    "type": "opp_tiebreak_done",
                }, exclude=websocket)

    except WebSocketDisconnect:
        manager.disconnect_match(match_id, websocket)
        await manager.broadcast_match(match_id, {
            "type": "opponent_disconnected",
        })


@router.websocket("/ws/matchmaking")
async def ws_matchmaking(
    websocket: WebSocket,
    token: Optional[str] = Query(None),
):
    """
    Matchmaking queue WebSocket.

    Client → server:
      {"type": "find",   "filters": {...}, "profile": {...}}
      {"type": "cancel"}
      {"type": "ping"}

    Server → client:
      {"type": "status",    "message": "..."}
      {"type": "matched",   "match_id": "...", "opponent": {...}}
      {"type": "cancelled"}
      {"type": "pong"}
    """
    user_id = await _auth_and_accept(websocket, token)
    if not user_id:
        return

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            t = msg.get("type")

            if t == "find":
                filters = msg.get("filters", {})
                profile = msg.get("profile", {})
                profile["user_id"] = user_id
                await manager.join_matchmaking(websocket, user_id, filters, profile)

            elif t == "cancel":
                manager.leave_matchmaking(user_id)
                await manager.send_personal(websocket, {"type": "cancelled"})

            elif t == "ping":
                await manager.send_personal(websocket, {"type": "pong"})

    except WebSocketDisconnect:
        manager.leave_matchmaking(user_id)
