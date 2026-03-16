"""
Match scoring and lifecycle endpoints:
  POST /api/matches/{id}/set      — submit one set (set-system)
  POST /api/matches/{id}/score    — submit all arrows (total-score mode)
  GET  /api/matches/{id}/status   — poll match state
  GET  /api/matches/mine/active   — active matches for session restore
  GET  /api/my-challenges         — merged challenges + active matches
  GET  /api/matches/{id}          — full match detail
  POST /api/matches/{id}/forfeit  — forfeit a match
"""
import asyncio
from datetime import datetime
from typing import List, Optional

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from core.deps import get_db, get_current_user
from models.models import (
    ArrowScore, Challenge, ChallengeKindEnum, Match, MatchParticipant,
    MatchResultEnum, MatchTypeEnum, Profile, ScoringEnum, User,
)
from schemas.matches import (
    ActiveMatchOut, MatchOut, MatchStatusOut,
    ScoreSubmission, SetResult, SetSubmission,
)
from services.challenges import challenge_to_out
from services.match import (
    build_judge_status, count_set_points,
    get_opponent, get_participant, get_profile_name,
    load_match, match_to_out,
)
from services.tiebreak import (
    create_tiebreak_match, get_tiebreak_match,
    notify_tiebreak_started, resolve_parent_from_tiebreak,
)
from ws.manager import manager

router = APIRouter(prefix="/api", tags=["matches"])


# ── Set-system ────────────────────────────────────────────────────────────────

@router.post("/matches/{match_id}/set", response_model=SetResult)
async def submit_set(
    match_id:     str,
    sub:          SetSubmission,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    """
    Submit one set of 3 arrows (or 1 for sudden-death tiebreak).
    Server resolves the set when both players have submitted the same set_number.

    World Archery Gold round rules:
      - Win → 2 pts · Draw → 1 pt each · Loss → 0 pts
      - First to 6 pts wins the match
      - At 5:5 → sudden-death (set_number=0): highest single arrow wins; repeat if equal
      - Loser of a set shoots first next set; draw keeps same order
    """
    match     = load_match(match_id, db)
    challenge = match.challenge

    # If this normal match has an active tiebreak child, redirect there
    if challenge and challenge.challenge_kind == ChallengeKindEnum.normal:
        tb_child = get_tiebreak_match(match.id, db)
        if tb_child and tb_child.status != "complete":
            match_id  = tb_child.id
            match     = tb_child
            challenge = match.challenge

    # Already complete — return final state
    if match.status == "complete":
        me  = get_participant(match, current_user.id)
        opp = get_opponent(match, current_user.id)
        my_pts  = me.final_score  or 0
        opp_pts = opp.final_score or 0 if opp else 0
        match_winner = (
            "me"       if me.result == MatchResultEnum.win  else
            "opponent" if me.result == MatchResultEnum.loss else None
        )
        return SetResult(
            set_number=sub.set_number, both_submitted=True,
            my_set_total=sum(sub.arrows), opp_set_total=None,
            set_winner=None, my_set_points=my_pts, opp_set_points=opp_pts,
            match_complete=True, match_winner=match_winner, match_result=match_winner,
            tiebreak_required=False, next_first_to_act=None,
            judge_status="Match already completed.",
        )

    if challenge and challenge.discipline.value != "target":
        raise HTTPException(status_code=501, detail=f"Discipline '{challenge.discipline.value}' not yet implemented")

    me  = get_participant(match, current_user.id)
    opp = get_opponent(match, current_user.id)

    # Restore in-memory participant registry if lost after server restart
    manager.ensure_match_registered(match_id, match.participants)

    # Persist set arrows (replace on resubmit)
    db.query(ArrowScore).filter(
        ArrowScore.participant_id == me.id,
        ArrowScore.set_number     == sub.set_number,
    ).delete()
    for idx, val in enumerate(sub.arrows):
        db.add(ArrowScore(
            participant_id = me.id,
            arrow_index    = sub.set_number * 10 + idx,
            value          = val,
            set_number     = sub.set_number,
        ))
    db.flush()

    my_total  = sum(sub.arrows)
    my_name   = get_profile_name(current_user.id, db)
    opp_name  = get_profile_name(opp.user_id, db) if opp else "Opponent"
    my_set_pts  = count_set_points(me, match_id, db)
    opp_set_pts = count_set_points(opp, match_id, db) if opp else 0

    opp_set_arrows = (
        db.query(ArrowScore).filter(
            ArrowScore.participant_id == opp.id,
            ArrowScore.set_number     == sub.set_number,
        ).all()
        if opp else []
    )

    # Opponent hasn't submitted yet — hold
    if not opp_set_arrows:
        db.commit()
        if opp:
            asyncio.create_task(manager.notify_user(opp.user_id, {
                "type": "opponent_score_submitted", "match_id": match_id, "opponent_name": my_name,
            }))
            asyncio.create_task(manager.notify_match_opponent(match_id, current_user.id, {
                "type": "opp_set_done", "match_id": match_id,
                "set_number": sub.set_number, "set_total": my_total,
            }))
        return SetResult(
            set_number=sub.set_number, both_submitted=False,
            my_set_total=my_total, opp_set_total=None,
            set_winner=None, my_set_points=my_set_pts, opp_set_points=opp_set_pts,
            match_complete=False, match_winner=None, match_result=None,
            tiebreak_required=False, next_first_to_act=match.first_to_act,
            judge_status=f"Set {sub.set_number}: your arrows recorded — waiting for {opp_name}…",
        )

    # Both submitted — resolve
    opp_total = sum(a.value for a in opp_set_arrows)
    if my_total > opp_total:
        set_winner, me_pts_gained, opp_pts_gained = "me",       2, 0
        next_first = opp.user_id
    elif opp_total > my_total:
        set_winner, me_pts_gained, opp_pts_gained = "opponent", 0, 2
        next_first = current_user.id
    else:
        set_winner, me_pts_gained, opp_pts_gained = "draw",     1, 1
        next_first = match.first_to_act

    db.flush()
    new_my_pts  = count_set_points(me,  match_id, db)
    new_opp_pts = count_set_points(opp, match_id, db)
    me.final_score  = new_my_pts
    opp.final_score = new_opp_pts
    match.first_to_act = next_first

    match_complete = new_my_pts >= 6 or new_opp_pts >= 6
    match_winner   = None
    tiebreak       = False

    if match_complete:
        if new_my_pts > new_opp_pts:
            match_winner, me.result, opp.result = "me",       MatchResultEnum.win,  MatchResultEnum.loss
            judge = f"Match complete — {my_name} wins {new_my_pts}:{new_opp_pts}!"
        elif new_opp_pts > new_my_pts:
            match_winner, me.result, opp.result = "opponent", MatchResultEnum.loss, MatchResultEnum.win
            judge = f"Match complete — {opp_name} wins {new_opp_pts}:{new_my_pts}"
        else:
            tiebreak, match_complete = True, False
            judge = "Scores level at 6:6 — sudden-death arrow! One arrow each, highest wins."

        if not tiebreak:
            match.status       = "complete"
            match.completed_at = datetime.utcnow()
            winner_uid = current_user.id if match_winner == "me" else opp.user_id
            asyncio.create_task(manager.notify_match_all(match_id, {
                "type": "match_complete", "match_id": match_id, "winner_id": winner_uid,
            }))
    else:
        if set_winner == "me":
            set_label = f"{my_name} wins this set!"
        elif set_winner == "opponent":
            set_label = f"{opp_name} wins this set"
        else:
            set_label = "Set drawn — 1 pt each"
        next_name = my_name if next_first == current_user.id else opp_name
        judge = (
            f"Set {sub.set_number}: {my_name} {my_total} – {opp_name} {opp_total} — {set_label}  "
            f"[{my_name} {new_my_pts}:{new_opp_pts} {opp_name}]  "
            f"Next: {next_name} shoots first."
        )
        asyncio.create_task(manager.notify_match_all(match_id, {
            "type":       "set_resolved",
            "match_id":   match_id,
            "set_number": sub.set_number,
            "scores": {
                current_user.id: {"total": my_total,  "pts": new_my_pts},
                opp.user_id:     {"total": opp_total, "pts": new_opp_pts},
            },
            "winner_id": (
                current_user.id if set_winner == "me" else
                opp.user_id     if set_winner == "opponent" else None
            ),
            "next_first": next_first,
        }))

    db.commit()
    return SetResult(
        set_number=sub.set_number, both_submitted=True,
        my_set_total=my_total, opp_set_total=opp_total,
        set_winner=set_winner, my_set_points=new_my_pts, opp_set_points=new_opp_pts,
        match_complete=match_complete, match_winner=match_winner, match_result=match_winner,
        tiebreak_required=tiebreak,
        next_first_to_act=next_first if not match_complete else None,
        judge_status=judge,
    )


# ── Total-score ───────────────────────────────────────────────────────────────

@router.post("/matches/{match_id}/score", status_code=200)
async def submit_score(
    match_id:     str,
    submission:   ScoreSubmission,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    """
    Submit all arrows for total-score mode.
    If both players tie, a sudden-death tiebreak match is created server-side.
    Client polls GET /api/matches/{id}/status until resolved.
    """
    match = load_match(match_id, db)

    # Redirect to active tiebreak child if one exists
    if match.challenge and match.challenge.challenge_kind == ChallengeKindEnum.normal:
        tb_child = get_tiebreak_match(match.id, db)
        if tb_child and tb_child.status != "complete":
            match_id = tb_child.id
            match    = tb_child

    if match.status == "complete":
        return {"status": "already_complete", "match_complete": True, "tiebreak_required": False}

    me  = get_participant(match, current_user.id)
    opp = get_opponent(match, current_user.id)

    # Restore in-memory participant registry if lost after server restart
    manager.ensure_match_registered(match_id, match.participants)

    challenge = match.challenge
    if challenge:
        if challenge.discipline.value != "target":
            raise HTTPException(status_code=501, detail=f"Discipline '{challenge.discipline.value}' not yet implemented")
        expected = challenge.arrow_count or len(submission.arrows)
        if challenge.scoring == ScoringEnum.total and len(submission.arrows) != expected:
            raise HTTPException(status_code=400, detail=f"Expected {expected} arrows, got {len(submission.arrows)}")

    db.query(ArrowScore).filter(ArrowScore.participant_id == me.id).delete()
    for a in submission.arrows:
        db.add(ArrowScore(participant_id=me.id, arrow_index=a.arrow_index, value=a.value))
    me.final_score  = sum(a.value for a in submission.arrows)
    me.submitted_at = datetime.utcnow()
    db.commit()

    my_name = get_profile_name(current_user.id, db)
    if opp:
        asyncio.create_task(manager.notify_user(opp.user_id, {
            "type": "opponent_score_submitted", "match_id": match_id, "opponent_name": my_name,
        }))
        asyncio.create_task(manager.notify_match_opponent(match_id, current_user.id, {
            "type": "opp_score_done", "match_id": match_id,
        }))

    # ── Tiebreak child resolution ─────────────────────────────────────────────
    is_tiebreak_match = challenge and challenge.challenge_kind == ChallengeKindEnum.tiebreak
    if is_tiebreak_match:
        human    = [p for p in match.participants if not p.is_bot]
        all_done = all(p.submitted_at is not None for p in human)
        if not all_done:
            return {"status": "submitted", "match_complete": False,
                    "tiebreak_required": True, "tiebreak_match_id": match_id}

        if len(human) != 2:
            raise HTTPException(status_code=500, detail="Tiebreak match must have exactly 2 participants")

        p0, p1 = human[0], human[1]
        s0, s1 = p0.final_score or 0, p1.final_score or 0

        if s0 == s1:
            # Still tied — reset for another round
            for p in human:
                p.submitted_at = None
                p.final_score  = None
                db.query(ArrowScore).filter(ArrowScore.participant_id == p.id).delete()
            db.commit()
            parent_match = load_match(match.parent_match_id, db) if match.parent_match_id else match
            notify_tiebreak_started(parent_match, match, db)
            return {"status": "submitted", "match_complete": False,
                    "tiebreak_required": True, "tiebreak_match_id": match_id}

        my_p  = p0 if p0.user_id == current_user.id else p1
        opp_p = p1 if p0.user_id == current_user.id else p0
        my_p.result  = MatchResultEnum.win  if my_p.final_score > opp_p.final_score else MatchResultEnum.loss
        opp_p.result = MatchResultEnum.loss if my_p.result == MatchResultEnum.win    else MatchResultEnum.win

        match.status       = "complete"
        match.completed_at = datetime.utcnow()
        db.commit()

        resolve_parent_from_tiebreak(match, db)
        for p in human:
            asyncio.create_task(manager.notify_user(p.user_id, {
                "type": "match_complete", "match_id": match_id,
            }))
        return {"status": "submitted", "match_complete": True,
                "tiebreak_required": False, "tiebreak_match_id": None}

    # ── Normal match resolution ───────────────────────────────────────────────
    human    = [p for p in match.participants if not p.is_bot]
    all_done = all(p.submitted_at is not None for p in human)
    if all_done:
        _resolve_total_match(match, db)

    db.refresh(match)
    scores_eq = (
        all_done and len(human) == 2
        and human[0].final_score is not None
        and human[0].final_score == human[1].final_score
    )
    existing_tb = get_tiebreak_match(match_id, db)
    tiebreak    = scores_eq and match.status != "complete" and existing_tb is None

    if tiebreak:
        tb_match = create_tiebreak_match(match, db)
        notify_tiebreak_started(match, tb_match, db)
        return {"status": "submitted", "match_complete": False,
                "tiebreak_required": True, "tiebreak_match_id": tb_match.id}

    if match.status == "complete":
        for p in human:
            asyncio.create_task(manager.notify_user(p.user_id, {
                "type": "match_complete", "match_id": match_id,
            }))

    return {
        "status":            "submitted",
        "match_complete":    match.status == "complete",
        "tiebreak_required": bool(existing_tb),
        "tiebreak_match_id": existing_tb.id if existing_tb else None,
    }


# ── Status poll ───────────────────────────────────────────────────────────────

@router.get("/matches/{match_id}/status", response_model=MatchStatusOut)
def get_match_status(
    match_id:     str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    match = load_match(match_id, db)

    if match.status == "waiting":
        return MatchStatusOut(
            id=match.id, status="waiting",
            scoring=match.challenge.scoring.value if match.challenge else "total",
            my_score=None, opp_score=None,
            opp_submitted=False, my_submitted=False,
            tiebreak_my_arrow=None, tiebreak_opp_arrow=None,
            result=None, my_set_points=0, opp_set_points=0,
            current_set=1, sets=[], first_to_act=None,
            judge_status="Waiting for opponent to join…",
        )

    me        = get_participant(match, current_user.id)
    opp       = get_opponent(match, current_user.id)
    challenge = match.challenge
    scoring   = challenge.scoring.value if challenge else "total"
    result    = me.result.value if me.result != MatchResultEnum.pending else None

    tb_match     = get_tiebreak_match(match.id, db)
    tiebreak_req = tb_match is not None and tb_match.status != "complete"

    sets_out    = []
    current_set = 1
    if scoring == "sets":
        def _set_map(pid):
            return {
                r.set_number: r.total
                for r in db.query(
                    ArrowScore.set_number,
                    func.sum(ArrowScore.value).label("total"),
                )
                .filter(ArrowScore.participant_id == pid)
                .group_by(ArrowScore.set_number)
                .all()
            }
        my_map  = _set_map(me.id)
        opp_map = _set_map(opp.id) if opp else {}
        for sn in sorted(set(my_map) | set(opp_map)):
            mt, ot = my_map.get(sn), opp_map.get(sn)
            winner = None
            if mt is not None and ot is not None:
                winner = "me" if mt > ot else ("opponent" if ot > mt else "draw")
            sets_out.append({"set_number": sn, "my_total": mt, "opp_total": ot, "winner": winner})

        # current_set = last RESOLVED set (both submitted) + 1
        # Unresolved sets (only one player submitted) do NOT advance the counter.
        last_resolved = max(
            (s["set_number"] for s in sets_out if s["winner"] is not None),
            default=0,
        )
        current_set = last_resolved + 1

    opp_name = get_profile_name(opp.user_id, db) if opp else "Opponent"
    judge    = build_judge_status(match, me, opp, scoring, current_set, tiebreak_req, opp_name, current_user.id)

    opp_current_set_arrows = None
    if scoring == "sets" and opp:
        opp_set_rows = (
            db.query(ArrowScore)
            .filter(
                ArrowScore.participant_id == opp.id,
                ArrowScore.set_number     == current_set,
            )
            .order_by(ArrowScore.arrow_index)
            .all()
        )
        opp_submitted = len(opp_set_rows) > 0
        if opp_submitted:
            # Return individual arrow values (sorted by set-relative position 0,1,2)
            # arrow_index is stored as set_number*10 + position, so position = index % 10
            arrows_by_pos: dict = {(a.arrow_index % 10): a.value for a in opp_set_rows}
            opp_current_set_arrows = [arrows_by_pos.get(i) for i in range(3)]

        # my_submitted: have I already submitted arrows for the CURRENT set?
        my_submitted = db.query(ArrowScore).filter(
            ArrowScore.participant_id == me.id,
            ArrowScore.set_number     == current_set,
        ).first() is not None
    else:
        opp_submitted = opp.submitted_at is not None if opp else False
        my_submitted  = me.submitted_at  is not None

    tiebreak_my_arrow = tiebreak_opp_arrow = None
    if tiebreak_req and tb_match:
        tb_me  = next((p for p in tb_match.participants if p.user_id == current_user.id), None)
        tb_opp = next((p for p in tb_match.participants if p.user_id != current_user.id), None)
        my_submitted = tb_me.submitted_at is not None if tb_me else False
        if tb_me and tb_opp and tb_opp.submitted_at is not None:
            tiebreak_my_arrow  = tb_me.final_score
            tiebreak_opp_arrow = tb_opp.final_score

    return MatchStatusOut(
        id=match.id, status=match.status,
        scoring="tiebreak" if tiebreak_req else scoring,
        my_score=me.final_score  if scoring == "total" else None,
        opp_score=(
            (opp.final_score if (opp_submitted or match.status == "complete") else None)
            if scoring == "total" else None
        ),
        opp_submitted=opp_submitted, my_submitted=my_submitted,
        tiebreak_my_arrow=tiebreak_my_arrow, tiebreak_opp_arrow=tiebreak_opp_arrow,
        result=result,
        my_set_points=count_set_points(me,  match.id, db) if scoring == "sets" else (me.final_score or 0),
        opp_set_points=(
            count_set_points(opp, match.id, db) if (scoring == "sets" and opp)
            else (opp.final_score or 0 if opp else 0)
        ),
        current_set=current_set, sets=sets_out,
        first_to_act=match.first_to_act, judge_status=judge,
        opp_current_set_arrows=opp_current_set_arrows,
    )


# ── Active matches ────────────────────────────────────────────────────────────

@router.get("/matches/mine/active", response_model=List[ActiveMatchOut])
def get_my_active_matches(
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    """All non-complete matches the current user participates in."""
    rows = _collect_active_match_rows(current_user.id, db)
    return rows


@router.get("/my-challenges", response_model=List[dict])
def get_my_dashboard(
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    """
    Flat ChallengeOut array enriched with active-match fields.
    Single endpoint that powers the My Challenges screen.
    """
    result: list = []
    seen_ch_ids: set = set()

    # ── Active match participants ─────────────────────────────────────────────
    participants = (
        db.query(MatchParticipant)
        .filter(MatchParticipant.user_id == current_user.id, MatchParticipant.is_bot == False)
        .all()
    )

    for p in participants:
        match = load_match(p.match_id, db)
        if match.status == "complete":
            continue
        ch = match.challenge

        # Defaults — may be overridden below
        tiebreak_req = False
        tb_match_id  = None

        # Tiebreak child → represent via parent
        if ch and ch.challenge_kind == ChallengeKindEnum.tiebreak:
            if not match.parent_match_id:
                continue
            tb_match_id  = match.id
            parent_match = load_match(match.parent_match_id, db)
            if parent_match.status == "complete":
                continue
            parent_ch = parent_match.challenge
            if not parent_ch or parent_ch.challenge_kind != ChallengeKindEnum.normal:
                continue
            parent_p = next((x for x in parent_match.participants if x.user_id == current_user.id), None)
            if not parent_p:
                continue
            opp = get_opponent(parent_match, current_user.id)
            if not opp:
                continue
            ch, match, p, tiebreak_req = parent_ch, parent_match, parent_p, True

        elif ch and ch.challenge_kind == ChallengeKindEnum.rematch:
            # status="waiting"  → still pending, show accept/decline card
            # status="active"   → already accepted, treat as a normal active match
            #                     (fall through to the standard active-match rendering below)
            if match.status == "waiting":
                opp = get_opponent(match, current_user.id)
                opp_profile = db.query(Profile).filter(Profile.user_id == opp.user_id).first() if opp else None
                ch_id = ch.id
                if ch_id in seen_ch_ids:
                    continue
                seen_ch_ids.add(ch_id)
                result.append({
                    "id": ch.id, "match_id": match.id,
                    "match_type": ch.match_type.value, "scoring": ch.scoring.value,
                    "distance": ch.distance, "arrow_count": ch.arrow_count,
                    "is_private": True, "is_active": ch.is_active,
                    "created_at": ch.created_at.isoformat() if ch.created_at else None,
                    "opponent_name": opp_profile.name if opp_profile else "Opponent",
                    "opponent_id":   opp.user_id if opp else None,
                    "is_creator":    p.is_creator,
                    "rematch_pending": True, "is_rematch": True,
                })
                continue
            # status="active": fall through to normal active-match card rendering
        else:
            tb = get_tiebreak_match(match.id, db)
            tiebreak_req  = tb is not None and tb.status != "complete"
            tb_match_id   = tb.id if tb else None
            if not tiebreak_req:
                human    = [x for x in match.participants if not x.is_bot]
                all_done = all(x.submitted_at is not None for x in human)
                if all_done and len(human) == 2:
                    s0, s1 = human[0].final_score, human[1].final_score
                    if s0 is not None and s0 == s1:
                        tb_new       = create_tiebreak_match(match, db)
                        notify_tiebreak_started(match, tb_new, db)
                        tiebreak_req = True
                        tb_match_id  = tb_new.id

        if not ch:
            continue
        ch_id = ch.id
        if ch_id in seen_ch_ids:
            continue
        seen_ch_ids.add(ch_id)

        opp         = get_opponent(match, current_user.id)
        opp_profile = db.query(Profile).filter(Profile.user_id == opp.user_id).first() if opp else None
        result.append(challenge_to_out(ch,
            match_id          = match.id,
            opponent_name     = opp_profile.name if opp_profile else "Opponent",
            opponent_id       = opp.user_id if opp else None,
            is_creator        = p.is_creator,
            tiebreak_required = tiebreak_req,
            tiebreak_match_id = tb_match_id,
        ))

    # ── Waiting challenges (no match yet) ─────────────────────────────────────
    waiting = (
        db.query(Challenge)
        .options(joinedload(Challenge.creator).joinedload(User.profile))
        .filter(
            Challenge.creator_id     == current_user.id,
            Challenge.challenge_kind == ChallengeKindEnum.normal,
            Challenge.is_active      == True,
        )
        .order_by(Challenge.created_at.desc())
        .all()
    )
    for ch in waiting:
        if not ch.creator.profile or ch.id in seen_ch_ids:
            continue
        seen_ch_ids.add(ch.id)
        result.append(challenge_to_out(ch))

    return result


# ── Match detail ──────────────────────────────────────────────────────────────

@router.get("/matches/{match_id}", response_model=MatchOut)
def get_match(
    match_id:     str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    match = load_match(match_id, db)
    if not any(p.user_id == current_user.id for p in match.participants):
        raise HTTPException(status_code=403, detail="Not your match")
    return match_to_out(match, db)


# ── Forfeit ───────────────────────────────────────────────────────────────────

@router.post("/matches/{match_id}/forfeit", status_code=200)
async def forfeit_match(
    match_id:     str,
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
):
    match = load_match(match_id, db)
    if match.status == "complete":
        raise HTTPException(status_code=400, detail="Match already completed")

    me  = get_participant(match, current_user.id)
    opp = get_opponent(match, current_user.id)

    me.result = MatchResultEnum.loss
    if opp:
        opp.result = MatchResultEnum.win
    match.status       = "complete"
    match.completed_at = datetime.utcnow()
    db.commit()

    my_name = get_profile_name(current_user.id, db)
    if opp:
        asyncio.create_task(manager.notify_user(opp.user_id, {
            "type": "opponent_forfeited", "match_id": match_id, "opponent_name": my_name,
        }))
    return {"status": "forfeited", "match_id": match_id}


# ── Internal helpers ──────────────────────────────────────────────────────────

def _resolve_total_match(match: Match, db: Session) -> None:
    """Determine win/loss/draw for total-score mode. Tie keeps match active."""
    human = [p for p in match.participants if not p.is_bot]
    if len(human) < 2:
        return
    scores = {p.id: (p.final_score or 0) for p in human}
    if len(set(scores.values())) == 1:
        return  # tie — handled separately via tiebreak
    max_score = max(scores.values())
    for p in human:
        p.result = MatchResultEnum.win if scores[p.id] == max_score else MatchResultEnum.loss
    match.status       = "complete"
    match.completed_at = datetime.utcnow()
    db.commit()


def _collect_active_match_rows(user_id: str, db: Session) -> List[ActiveMatchOut]:
    """
    Shared iteration logic for get_my_active_matches and (indirectly) the resume tab.
    Returns ActiveMatchOut entries, one per parent match.
    Tiebreak child matches are represented via their parent entry.
    """
    participants = (
        db.query(MatchParticipant)
        .filter(MatchParticipant.user_id == user_id, MatchParticipant.is_bot == False)
        .all()
    )

    result: List[ActiveMatchOut] = []
    seen_ids: set = set()

    for p in participants:
        match = load_match(p.match_id, db)
        if match.status == "complete":
            continue
        ch = match.challenge

        # Tiebreak child → emit parent entry instead
        if ch and ch.challenge_kind == ChallengeKindEnum.tiebreak:
            if not match.parent_match_id or match.parent_match_id in seen_ids:
                continue
            parent_match = load_match(match.parent_match_id, db)
            if parent_match.status == "complete":
                continue
            parent_ch = parent_match.challenge
            parent_p  = next((x for x in parent_match.participants if x.user_id == user_id), None)
            opp       = get_opponent(parent_match, user_id)
            if not parent_p or not opp:
                continue
            opp_profile = db.query(Profile).filter(Profile.user_id == opp.user_id).first()
            seen_ids.add(match.parent_match_id)
            result.append(ActiveMatchOut(
                match_id=parent_match.id, challenge_id=parent_match.challenge_id,
                opponent_name=opp_profile.name if opp_profile else "Opponent",
                opponent_id=opp.user_id,
                scoring=parent_ch.scoring.value if parent_ch else "total",
                distance=parent_ch.distance if parent_ch else "30m",
                arrow_count=parent_ch.arrow_count if parent_ch else 18,
                match_type=parent_ch.match_type.value if parent_ch else "live",
                discipline=parent_ch.discipline.value if parent_ch else "target",
                is_creator=parent_p.is_creator, first_to_act=parent_match.first_to_act,
                challenge_kind="normal", parent_match_id=None,
                tiebreak_required=True, tiebreak_match_id=match.id,
            ))
            continue

        if match.id in seen_ids:
            continue
        seen_ids.add(match.id)

        opp = get_opponent(match, user_id)
        if not opp:
            continue
        opp_profile = db.query(Profile).filter(Profile.user_id == opp.user_id).first()
        opp_name    = opp_profile.name if opp_profile else "Opponent"

        tb_match     = get_tiebreak_match(match.id, db)
        tiebreak_req = tb_match is not None and tb_match.status != "complete"

        if not tiebreak_req:
            human    = [p2 for p2 in match.participants if not p2.is_bot]
            all_done = all(p2.submitted_at is not None for p2 in human)
            if all_done and len(human) == 2:
                s0, s1 = human[0].final_score, human[1].final_score
                if s0 is not None and s0 == s1:
                    tb_match     = create_tiebreak_match(match, db)
                    notify_tiebreak_started(match, tb_match, db)
                    tiebreak_req = True

        result.append(ActiveMatchOut(
            match_id=match.id, challenge_id=match.challenge_id,
            opponent_name=opp_name, opponent_id=opp.user_id,
            scoring=ch.scoring.value if ch else "total",
            distance=ch.distance if ch else "30m",
            arrow_count=ch.arrow_count if ch else 18,
            match_type=ch.match_type.value if ch else "live",
            discipline=ch.discipline.value if ch else "target",
            is_creator=p.is_creator, first_to_act=match.first_to_act,
            challenge_kind=ch.challenge_kind.value if ch else "normal",
            parent_match_id=match.parent_match_id,
            tiebreak_required=tiebreak_req,
            tiebreak_match_id=tb_match.id if tb_match else None,
        ))

    return result
