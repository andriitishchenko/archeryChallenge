"""
WebSocket endpoints:
  WS /ws/match/{match_id}?token=...              — live match real-time updates
  WS /ws/matchmaking?token=...                   — matchmaking queue
  WS /ws/challenges?token=...                    — public challenge list feed
  WS /ws/challenge/{challenge_id}/wait?token=... — creator waits for opponent
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

    Client -> server:
      {"type": "ping"}
      {"type": "arrow",              "arrow_index": N, "value": V}
      {"type": "set_submitted",      "set_number": N}
      {"type": "score_submitted"}
      {"type": "tiebreak_submitted", "set_number": 0}

    Server -> client (broadcast to opponent):
      {"type": "pong"}
      {"type": "opp_arrow",          "arrow_index": N, "value": V}
      {"type": "opp_set_done",        "set_number": N}
      {"type": "opp_score_done"}
      {"type": "opp_tiebreak_done"}
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
                await manager.broadcast_match(match_id, {
                    "type": "opp_arrow",
                    "arrow_index": msg.get("arrow_index"),
                    "value": msg.get("value"),
                }, exclude=websocket)

            elif t == "set_submitted":
                await manager.broadcast_match(match_id, {
                    "type": "opp_set_done",
                    "set_number": msg.get("set_number"),
                }, exclude=websocket)

            elif t == "score_submitted":
                await manager.broadcast_match(match_id, {
                    "type": "opp_score_done",
                }, exclude=websocket)

            elif t == "tiebreak_submitted":
                await manager.broadcast_match(match_id, {
                    "type": "opp_tiebreak_done",
                }, exclude=websocket)

    except WebSocketDisconnect:
        manager.disconnect_match(match_id, websocket)
        await manager.broadcast_match(match_id, {"type": "opponent_disconnected"})


@router.websocket("/ws/challenges")
async def ws_challenges_feed(
    websocket: WebSocket,
    token: Optional[str] = Query(None),
):
    """
    Public challenges feed — real-time updates for the challenge list screen.

    Server -> client:
      {"type": "new_challenge",     "challenge": {...}}
      {"type": "challenge_removed", "challenge_id": "..."}
      {"type": "pong"}
    Client -> server:
      {"type": "ping"}
    """
    user_id = await _auth_and_accept(websocket, token)
    if not user_id:
        return

    manager.register_challenge_feed(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "ping":
                await manager.send_personal(websocket, {"type": "pong"})
    except WebSocketDisconnect:
        manager.unregister_challenge_feed(websocket)


@router.websocket("/ws/challenge/{challenge_id}/wait")
async def ws_challenge_wait(
    websocket: WebSocket,
    challenge_id: str,
    token: Optional[str] = Query(None),
):
    """
    Creator waits here after creating a live challenge.
    Receives opponent_joined with the real match_id once someone joins.

    Server -> client:
      {"type": "opponent_joined", "match_id": "...", "opponent_name": "..."}
      {"type": "pong"}
    Client -> server:
      {"type": "ping"}
    """
    user_id = await _auth_and_accept(websocket, token)
    if not user_id:
        return

    manager.register_creator_waiting(challenge_id, user_id, websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "ping":
                await manager.send_personal(websocket, {"type": "pong"})
    except WebSocketDisconnect:
        manager.unregister_creator_waiting(challenge_id, websocket)


@router.websocket("/ws/matchmaking")
async def ws_matchmaking(
    websocket: WebSocket,
    token: Optional[str] = Query(None),
):
    """
    Matchmaking queue WebSocket.

    Client -> server:
      {"type": "find",   "filters": {...}, "profile": {...}}
      {"type": "cancel"}
      {"type": "ping"}

    Server -> client:
      {"type": "status",  "message": "..."}
      {"type": "matched", "match_id": "...", "opponent": {...}}
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
