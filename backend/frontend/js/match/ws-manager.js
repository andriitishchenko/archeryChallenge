// =============================================
// ARROWMATCH — WebSocket Manager
// Owns ALL WebSocket connections and translates every server message
// into an EventBus event. No business logic lives here — just routing.
//
// Server is the single source of truth.  This module is the bridge between
// the network and the EventBus; components never touch WebSocket directly.
//
// Depends on: core/state.js, core/event-bus.js
// =============================================

// ── Internal connection registry ──────────────────────────────────────────────
// matchSockets is declared in state.js so all legacy call-sites still work.
// _creatorWaitSocket and _challengeFeedSocket and mmSocket are module-level.

let _challengeFeedSocket = null;
let _creatorWaitSocket   = null;

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Build a ping timer that keeps a WS alive. Returns the interval id. */
function _startPing(ws, intervalMs = 20000) {
  return setInterval(() => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'ping' }));
  }, intervalMs);
}

/** Safely close a socket and clear its ping timer. */
function _closeSocket(ws) {
  if (!ws) return;
  if (ws._pingTimer) { clearInterval(ws._pingTimer); ws._pingTimer = null; }
  try { ws.close(); } catch {}
}

// ── Challenge feed ────────────────────────────────────────────────────────────

/**
 * Connect to /ws/challenges for real-time challenge list updates.
 * Emits:
 *   EVENT_TYPES.WS_NEW_CHALLENGE       { challenge }
 *   EVENT_TYPES.WS_CHALLENGE_REMOVED   { challenge_id }
 */
function connectChallengeFeed() {
  if (_challengeFeedSocket &&
      (_challengeFeedSocket.readyState === WebSocket.OPEN ||
       _challengeFeedSocket.readyState === WebSocket.CONNECTING)) return;

  try {
    _challengeFeedSocket = new WebSocket(
      `${WS_BASE}/ws/challenges?token=${STATE.accessToken || ''}`
    );

    _challengeFeedSocket.onopen = () => {
      _challengeFeedSocket._pingTimer = _startPing(_challengeFeedSocket, 25000);
    };

    _challengeFeedSocket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'new_challenge') {
        EventBus.emit(EVENT_TYPES.WS_NEW_CHALLENGE, { challenge: msg.challenge });
      } else if (msg.type === 'challenge_removed') {
        EventBus.emit(EVENT_TYPES.WS_CHALLENGE_REMOVED, { challenge_id: msg.challenge_id });
      }
      // pong — intentionally ignored
    };

    _challengeFeedSocket.onerror = () => {};

    _challengeFeedSocket.onclose = (e) => {
      if (_challengeFeedSocket?._pingTimer) clearInterval(_challengeFeedSocket._pingTimer);
      _challengeFeedSocket = null;
      // Auto-reconnect unless intentionally closed
      if (e.code !== 1000 && STATE.accessToken) {
        setTimeout(connectChallengeFeed, 5000);
      }
    };

  } catch (err) {
    console.warn('[WsManager] challenge feed unavailable:', err);
  }
}

function disconnectChallengeFeed() {
  _closeSocket(_challengeFeedSocket);
  _challengeFeedSocket = null;
}

// ── Creator wait socket ───────────────────────────────────────────────────────

/**
 * Open /ws/challenge/{id}/wait so the server can push opponent_joined
 * to the creator with the real match_id.
 *
 * Emits: EVENT_TYPES.WS_OPPONENT_JOINED { matchId, match_id, opponent_name, challengeId }
 */
function openCreatorWaitSocket(challengeId) {
  _closeSocket(_creatorWaitSocket);
  _creatorWaitSocket = null;

  try {
    _creatorWaitSocket = new WebSocket(
      `${WS_BASE}/ws/challenge/${challengeId}/wait?token=${STATE.accessToken || ''}`
    );

    _creatorWaitSocket.onopen = () => {
      _creatorWaitSocket._pingTimer = _startPing(_creatorWaitSocket);
    };

    _creatorWaitSocket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'opponent_joined') {
        closeCreatorWaitSocket();
        EventBus.emit(EVENT_TYPES.WS_OPPONENT_JOINED, {
          challengeId,
          match_id:      msg.match_id,
          opponent_name: msg.opponent_name || 'Opponent',
        });
      }
    };

    _creatorWaitSocket.onerror  = () => {};
    _creatorWaitSocket.onclose  = () => {
      if (_creatorWaitSocket?._pingTimer) clearInterval(_creatorWaitSocket._pingTimer);
    };

  } catch (err) {
    console.warn('[WsManager] creator wait socket unavailable:', err);
  }
}

function closeCreatorWaitSocket() {
  _closeSocket(_creatorWaitSocket);
  _creatorWaitSocket = null;
}

// ── Per-match socket ──────────────────────────────────────────────────────────

/**
 * Open /ws/match/{matchId} and translate every server message into an
 * EventBus event.  The match ID is included in every payload so consumers
 * can decide whether the event is for the currently displayed match.
 *
 * Emits:
 *   WS_OPPONENT_JOINED        { matchId, match_id, opponent_name }
 *   WS_OPP_ARROW              { matchId, arrow_index, value }
 *   WS_OPP_SET_DONE           { matchId }
 *   WS_OPP_TIEBREAK_DONE      { matchId }
 *   WS_OPP_SCORE_DONE         { matchId }
 *   WS_OPPONENT_FORFEITED     { matchId }
 *   WS_OPPONENT_DISCONNECTED  { matchId }
 *   WS_REMATCH_PROPOSED       { matchId, proposed_by }
 *   WS_REMATCH_ACCEPTED       { matchId, match_id, challenge_id, opponent_name,
 *                               scoring, distance, arrow_count, match_type }
 *   WS_REMATCH_DECLINED       { matchId, declined_by }
 *   WS_CONNECTED              { matchId }
 *   WS_DISCONNECTED           { matchId }
 *   WS_ERROR                  { matchId }
 */
function connectMatchSocket(matchId) {
  // Close any existing socket for this match
  if (matchSockets[matchId]) {
    _closeSocket(matchSockets[matchId]);
    delete matchSockets[matchId];
  }

  try {
    const ws = new WebSocket(
      `${WS_BASE}/ws/match/${matchId}?token=${STATE.accessToken || ''}`
    );
    matchSockets[matchId] = ws;

    ws.onopen = () => {
      ws._pingTimer = _startPing(ws);
      EventBus.emit(EVENT_TYPES.WS_CONNECTED, { matchId });
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      // Map raw server message type → EventBus event
      switch (msg.type) {
        case 'opponent_joined':
          EventBus.emit(EVENT_TYPES.WS_OPPONENT_JOINED, {
            matchId,
            match_id:      msg.match_id,
            opponent_name: msg.opponent_name,
          });
          break;

        case 'opp_arrow':
          EventBus.emit(EVENT_TYPES.WS_OPP_ARROW, {
            matchId,
            arrow_index: msg.arrow_index,
            value:       msg.value,
          });
          break;

        case 'opp_set_done':
          EventBus.emit(EVENT_TYPES.WS_OPP_SET_DONE, { matchId });
          break;

        case 'opp_tiebreak_done':
          EventBus.emit(EVENT_TYPES.WS_OPP_TIEBREAK_DONE, { matchId });
          break;

        case 'opp_score_done':
          EventBus.emit(EVENT_TYPES.WS_OPP_SCORE_DONE, { matchId });
          break;

        case 'opponent_forfeited':
          EventBus.emit(EVENT_TYPES.WS_OPPONENT_FORFEITED, { matchId });
          break;

        case 'opponent_disconnected':
          EventBus.emit(EVENT_TYPES.WS_OPPONENT_DISCONNECTED, { matchId });
          break;

        case 'rematch_proposed':
          EventBus.emit(EVENT_TYPES.WS_REMATCH_PROPOSED, {
            matchId,
            proposed_by: msg.proposed_by,
          });
          break;

        case 'rematch_accepted':
          EventBus.emit(EVENT_TYPES.WS_REMATCH_ACCEPTED, {
            matchId,
            match_id:      msg.match_id,
            challenge_id:  msg.challenge_id,
            opponent_name: msg.opponent_name,
            scoring:       msg.scoring,
            distance:      msg.distance,
            arrow_count:   msg.arrow_count,
            match_type:    msg.match_type,
          });
          break;

        case 'rematch_declined':
          EventBus.emit(EVENT_TYPES.WS_REMATCH_DECLINED, {
            matchId,
            declined_by: msg.declined_by,
          });
          break;

        case 'pong':
          break; // intentionally ignored

        default:
          console.debug('[WsManager] unhandled message type:', msg.type);
      }
    };

    ws.onerror = () => {
      EventBus.emit(EVENT_TYPES.WS_ERROR, { matchId });
    };

    ws.onclose = () => {
      if (ws._pingTimer) { clearInterval(ws._pingTimer); ws._pingTimer = null; }
      EventBus.emit(EVENT_TYPES.WS_DISCONNECTED, { matchId });
    };

  } catch (err) {
    console.warn('[WsManager] match socket unavailable:', matchId, err);
  }
}

function disconnectMatchSocket(matchId) {
  if (matchSockets[matchId]) {
    _closeSocket(matchSockets[matchId]);
    delete matchSockets[matchId];
  }
}

/** Send a message on the currently active match socket. */
function sendMatchMessage(payload, matchId = STATE.currentMatchId) {
  const ws = matchSockets[matchId];
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ── Matchmaking socket ────────────────────────────────────────────────────────

/**
 * Connect to /ws/matchmaking for quick-find flow.
 * Emits:
 *   WS_MM_STATUS   { message }
 *   WS_MM_MATCHED  { match_id, opponent }
 *   WS_ERROR       { matchId: 'matchmaking' }
 *   WS_DISCONNECTED { matchId: 'matchmaking', code }
 */
function connectMatchmaking(profilePayload) {
  if (mmSocket) { _closeSocket(mmSocket); mmSocket = null; }

  try {
    mmSocket = new WebSocket(
      `${WS_BASE}/ws/matchmaking?token=${STATE.accessToken || ''}`
    );

    mmSocket.onopen = () => {
      mmSocket.send(JSON.stringify({
        type:    'find',
        filters: STATE.filters,
        profile: profilePayload,
      }));
    };

    mmSocket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'status') {
        EventBus.emit(EVENT_TYPES.WS_MM_STATUS, { message: msg.message });
      } else if (msg.type === 'matched') {
        _closeSocket(mmSocket);
        mmSocket = null;
        EventBus.emit(EVENT_TYPES.WS_MM_MATCHED, {
          match_id: msg.match_id,
          opponent: msg.opponent,
        });
      }
    };

    mmSocket.onerror  = () => {
      EventBus.emit(EVENT_TYPES.WS_ERROR, { matchId: 'matchmaking' });
    };
    mmSocket.onclose  = (e) => {
      if (e.code !== 1000)
        EventBus.emit(EVENT_TYPES.WS_DISCONNECTED, { matchId: 'matchmaking', code: e.code });
    };

  } catch (err) {
    EventBus.emit(EVENT_TYPES.WS_ERROR, { matchId: 'matchmaking' });
  }
}

function disconnectMatchmaking() {
  _closeSocket(mmSocket);
  mmSocket = null;
}
