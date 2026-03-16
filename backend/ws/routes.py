"""
WebSocket endpoints — single connection architecture.

  WS /ws/user?token=...   — the only WebSocket endpoint.
                            Persistent per-user socket for the entire session.
                            Handles ALL server→client events and ALL client→server events.

Client → server message types:
  {type: "ping"}
  {type: "arrow",    match_id, arrow_index, value}   — live arrow indicator to opponent
  {type: "mm_find",  filters, profile}               — enter matchmaking queue
  {type: "mm_cancel"}                                — leave matchmaking queue

All score submission, set resolution, and match lifecycle use REST endpoints.
The WS is used only for real-time push (server→client) and low-latency
arrow streaming (client→server→opponent).
"""
import json
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from core.security import get_user_id_from_token
from ws.manager import manager

router = APIRouter(tags=["websocket"])


async def _auth_and_accept(websocket: WebSocket, token: Optional[str]) -> Optional[str]:
    """Accept first, then validate token."""
    await websocket.accept()
    user_id = get_user_id_from_token(token) if token else None
    if not user_id:
        await websocket.close(code=4001, reason="Unauthorized")
        return None
    return user_id


@router.websocket("/ws/user")
async def ws_user(
    websocket: WebSocket,
    token: Optional[str] = Query(None),
):
    """
    Single persistent WebSocket for the entire session.

    Server → client events (all include match_id where relevant):
      opponent_score_submitted, opponent_forfeited, challenge_expired,
      new_challenge, challenge_removed, opponent_joined, match_complete,
      tiebreak_started, match_ready,
      rematch_proposed, rematch_accepted, rematch_declined,
      opp_arrow, opp_set_done, opp_score_done, opp_tiebreak_done,
      set_resolved, opponent_disconnected,
      mm_status, mm_matched, mm_cancelled, pong

    Client → server:
      ping                                      — keepalive
      arrow      {match_id, arrow_index, value} — stream live arrow to opponent
      mm_find    {filters, profile}             — join matchmaking queue
      mm_cancel                                 — leave matchmaking queue
    """
    user_id = await _auth_and_accept(websocket, token)
    if not user_id:
        return

    manager.register_user_socket(user_id, websocket)

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

            # ── Live arrow streaming (low-latency indicator only) ───────────
            elif t == "arrow":
                match_id = msg.get("match_id")
                if match_id:
                    await manager.notify_match_opponent(match_id, user_id, {
                        "type":        "opp_arrow",
                        "match_id":    match_id,
                        "arrow_index": msg.get("arrow_index"),
                        "value":       msg.get("value"),
                    })

            # ── Matchmaking ────────────────────────────────────────────────
            elif t == "mm_find":
                profile         = dict(msg.get("profile") or {})
                profile["user_id"] = user_id
                await manager.join_matchmaking(
                    websocket, user_id,
                    filters=msg.get("filters") or {},
                    profile=profile,
                )

            elif t == "mm_cancel":
                manager.leave_matchmaking(user_id)
                await manager.send_personal(websocket, {"type": "mm_cancelled"})

            # Unknown message types are silently ignored

    except WebSocketDisconnect:
        manager.unregister_user_socket(user_id, websocket)
        manager.leave_matchmaking(user_id)
        await manager.notify_user_disconnected(user_id)
