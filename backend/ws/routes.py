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
import re
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from starlette.concurrency import run_in_threadpool

from core.security import get_user_id_from_token
from models.database import SessionLocal
from models.models import BowTypeEnum, GenderEnum, Profile, SkillLevelEnum
from ws.manager import manager

router = APIRouter(tags=["websocket"])
log = logging.getLogger("arrowmatch.websocket")
MAX_MESSAGE_BYTES = 65_536


def _is_valid_arrow_message(message: dict) -> bool:
    match_id = message.get("match_id")
    arrow_index = message.get("arrow_index")
    value = message.get("value")
    arrows = message.get("arrows")

    if not isinstance(match_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", match_id):
        return False
    if arrow_index is not None and (type(arrow_index) is not int or not 0 <= arrow_index <= 359):
        return False
    if value is not None and (type(value) is not int or not 0 <= value <= 10):
        return False
    if arrows is not None and (
        not isinstance(arrows, list)
        or len(arrows) > 360
        or any(item is not None and (type(item) is not int or not 0 <= item <= 10) for item in arrows)
    ):
        return False
    return arrow_index is not None or arrows is not None


def _load_matchmaking_profile(user_id: str) -> Optional[dict]:
    db = SessionLocal()
    try:
        profile = db.query(Profile).filter(Profile.user_id == user_id).first()
        if not profile:
            return None
        return {
            "user_id": user_id,
            "name": profile.name,
            "gender": profile.gender.value,
            "age": profile.age.value,
            "bow_type": profile.bow_type.value,
            "skill_level": profile.skill_level.value,
            "country": profile.country,
        }
    finally:
        db.close()


def _sanitize_matchmaking_filters(raw: object) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    enum_fields = {
        "skill": {item.value for item in SkillLevelEnum},
        "gender": {item.value for item in GenderEnum},
        "bow": {item.value for item in BowTypeEnum},
    }
    result = {}
    for key, allowed in enum_fields.items():
        values = raw.get(key)
        if values is None:
            continue
        if not isinstance(values, list) or len(values) > len(allowed):
            return None
        if any(not isinstance(value, str) or value not in allowed for value in values):
            return None
        result[key] = values
    return result


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
      rematch_cancelled,
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
            if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
                log.warning("WS RECV_REJECT user=%s reason=message_too_large", user_id)
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("WS RECV_INVALID user=%s reason=invalid_json", user_id)
                continue
            if not isinstance(msg, dict):
                log.warning("WS RECV_INVALID user=%s reason=expected_object", user_id)
                continue

            t = msg.get("type")
            if not isinstance(t, str) or len(t) > 32:
                log.warning("WS RECV_INVALID user=%s reason=invalid_type", user_id)
                continue

            if t not in {"ping", "arrow", "mm_find", "mm_cancel"}:
                log.warning("WS RECV_UNKNOWN user=%s", user_id)
                continue
            log.info("WS RECV user=%s type=%s", user_id, t)

            if t == "ping":
                await manager.send_personal(websocket, {"type": "pong"}, recipient_id=user_id)

            # ── Live arrow streaming (low-latency indicator only) ───────────
            elif t == "arrow":
                if _is_valid_arrow_message(msg):
                    match_id = msg["match_id"]
                    await manager.notify_match_opponent(match_id, user_id, {
                        "type":        "opp_arrow",
                        "match_id":    match_id,
                        "arrow_index": msg.get("arrow_index"),
                        "value":       msg.get("value"),
                        "arrows":      msg.get("arrows"),
                    })
                else:
                    log.warning("WS RECV_REJECT user=%s reason=invalid_arrow_preview", user_id)

            # ── Matchmaking ────────────────────────────────────────────────
            elif t == "mm_find":
                profile = await run_in_threadpool(_load_matchmaking_profile, user_id)
                filters = _sanitize_matchmaking_filters(msg.get("filters", {}))
                if profile is None:
                    await manager.send_personal(websocket, {
                        "type": "mm_error", "message": "Complete your profile before matchmaking.",
                    }, recipient_id=user_id)
                    continue
                if filters is None:
                    await manager.send_personal(websocket, {
                        "type": "mm_error", "message": "Matchmaking filters are invalid.",
                    }, recipient_id=user_id)
                    continue
                await manager.join_matchmaking(
                    websocket, user_id,
                    filters=filters,
                    profile=profile,
                )

            elif t == "mm_cancel":
                manager.leave_matchmaking(user_id)
                await manager.send_personal(websocket, {"type": "mm_cancelled"}, recipient_id=user_id)

            else:
                log.warning("WS RECV_UNKNOWN user=%s type=%s", user_id, t)

    except WebSocketDisconnect as exc:
        log.info("WS CLOSED user=%s code=%s", user_id, exc.code)
    except Exception as exc:
        log.error("WS HANDLER_FAILED user=%s error=%s", user_id, type(exc).__name__)
    finally:
        manager.unregister_user_socket(user_id, websocket)
        manager.leave_matchmaking(user_id)
        await manager.notify_user_disconnected(user_id)
