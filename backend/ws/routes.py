"""
WebSocket endpoints — single connection architecture.

  WS /ws/user?token=...   — the only WebSocket endpoint.
                            Persistent per-user socket for the entire session.
                            Handles ALL server→client events and ALL client→server events.

Client → server message types:
  {type: "ping"}
  {type: "arrow",    match_id, arrow_index, value}   — live arrow indicator; value may be null to clear, arrows may carry the full snapshot
  {type: "mm_find",  filters, profile}               — enter matchmaking queue
  {type: "mm_cancel"}                                — leave matchmaking queue

All score submission, set resolution, and match lifecycle use REST endpoints.
The WS is used only for real-time push (server→client) and low-latency
arrow streaming (client→server→opponent).
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from core.security import get_user_id_from_token
from ws.manager import manager

router = APIRouter(tags=["websocket"])
log = logging.getLogger("arrowmatch.websocket")


async def _auth_and_accept(websocket: WebSocket, token: Optional[str]) -> Optional[str]:
    """Accept first, then validate token."""
    await websocket.accept()
    user_id = get_user_id_from_token(token) if token else None
    if not user_id:
        log.warning("WS AUTH_FAILED token_present=%s", bool(token))
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
      tiebreak_started, set_tiebreak_started, match_ready,
      rematch_proposed, rematch_accepted, rematch_declined,
      opp_arrow, opp_set_done, opp_score_done, opp_tiebreak_done,
      set_resolved, opponent_disconnected,
      mm_status, mm_matched, mm_cancelled, pong

    Client → server:
      ping                                      — keepalive
      arrow      {match_id, arrow_index, value} — stream live arrow to opponent; null clears a preview, arrows may carry the full snapshot
      mm_find    {filters, profile}             — join matchmaking queue
      mm_cancel                                 — leave matchmaking queue

    The mm_matched event includes is_bot=true when it starts the local,
    non-persisted bot simulation.
    """
    user_id = await _auth_and_accept(websocket, token)
    if not user_id:
        log.warning("WS AUTH_FAILED")
        return

    manager.register_user_socket(user_id, websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("WS RECV_INVALID user=%s raw=%r", user_id, raw)
                continue

            t = msg.get("type")
            log.info(
                "WS RECV user=%s type=%s match=%s payload=%s",
                user_id, t, msg.get("match_id"),
                json.dumps(msg, ensure_ascii=False, sort_keys=True, default=str),
            )

            if t == "ping":
                await manager.send_personal(websocket, {"type": "pong"}, recipient_id=user_id)

            # ── Live arrow streaming (low-latency indicator only) ───────────
            elif t == "arrow":
                match_id = msg.get("match_id")
                if match_id:
                    await manager.notify_match_opponent(match_id, user_id, {
                        "type":        "opp_arrow",
                        "match_id":    match_id,
                        "arrow_index": msg.get("arrow_index"),
                        "value":       msg.get("value"),
                        "arrows":      msg.get("arrows"),
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
                await manager.send_personal(websocket, {"type": "mm_cancelled"}, recipient_id=user_id)

            else:
                log.warning("WS RECV_UNKNOWN user=%s type=%s", user_id, t)

    except WebSocketDisconnect as exc:
        log.info("WS CLOSED user=%s code=%s", user_id, exc.code)
        manager.unregister_user_socket(user_id, websocket)
        manager.leave_matchmaking(user_id)
        await manager.notify_user_disconnected(user_id)
