// =============================================
// ARROWMATCH — WebSocket (core/ws.js)
//
// Single /ws/user connection for the entire session.
// All server→client events are routed to EventBus here.
// All client→server messages go through WS.send().
//
// Public API:
//   WS.connect()        — call after login
//   WS.disconnect()     — call on logout
//   WS.reconnect()      — after token refresh
//   WS.send(payload)    — send any message to server
//   WS.status()         → 'open' | 'connecting' | 'closed'
//
// Convenience helpers (module-level):
//   sendMatchMessage(payload, matchId?)  — sends with match_id injected
//   connectMatchmaking(profile)          — sends mm_find
//   disconnectMatchmaking()              — sends mm_cancel
//
// Depends on: core/state.js, core/event-bus.js
// =============================================

const WS = (() => {

  let _ws             = null;
  let _pingTimer      = null;
  let _reconnectTimer = null;
  let _reconnectDelay = 1000;       // ms, doubles on each failed attempt
  const MAX_DELAY     = 30_000;
  let _intentional    = false;

  // ── Internal helpers ───────────────────────────────────────────────────────

  function _url() {
    return `${WS_BASE}/ws/user?token=${STATE.accessToken || ''}`;
  }

  function _startPing() {
    _pingTimer = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN)
        _ws.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
  }

  function _stopPing() {
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  }

  function _scheduleReconnect() {
    if (_reconnectTimer || _intentional || !STATE.accessToken) return;
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_DELAY);
      _open();
    }, _reconnectDelay);
  }

  // ── Route server → EventBus ────────────────────────────────────────────────

  function _route(msg) {
    switch (msg.type) {

      // ── Live scoring ────────────────────────────────────────────────────
      case 'opp_arrow':
        EventBus.emit(EVENT_TYPES.WS_OPP_ARROW, {
          matchId: msg.match_id, arrow_index: msg.arrow_index, value: msg.value });
        break;

      case 'opp_set_done':
        EventBus.emit(EVENT_TYPES.WS_OPP_SET_DONE, {
          matchId: msg.match_id, set_number: msg.set_number, set_total: msg.set_total });
        break;

      case 'set_resolved':
        EventBus.emit(EVENT_TYPES.WS_SET_RESOLVED, {
          matchId: msg.match_id, set_number: msg.set_number,
          scores: msg.scores, winner_id: msg.winner_id, next_first: msg.next_first });
        break;

      case 'opp_score_done':
        EventBus.emit(EVENT_TYPES.WS_OPP_SCORE_DONE, { matchId: msg.match_id });
        break;

      case 'opp_tiebreak_done':
        EventBus.emit(EVENT_TYPES.WS_OPP_TIEBREAK_DONE, { matchId: msg.match_id });
        break;

      // ── Match lifecycle ─────────────────────────────────────────────────
      case 'match_complete':
        EventBus.emit(EVENT_TYPES.WS_MATCH_COMPLETE, { matchId: msg.match_id });
        break;

      case 'opponent_disconnected':
        EventBus.emit(EVENT_TYPES.WS_OPPONENT_DISCONNECTED, { matchId: msg.match_id });
        break;

      case 'opponent_forfeited':
        EventBus.emit(EVENT_TYPES.WS_OPPONENT_FORFEITED, {
          matchId: msg.match_id, opponent_name: msg.opponent_name });
        break;

      case 'opponent_score_submitted':
        EventBus.emit(EVENT_TYPES.WS_OPP_SCORE_SUBMITTED, {
          matchId: msg.match_id, opponent_name: msg.opponent_name });
        break;

      case 'opponent_joined':
        EventBus.emit(EVENT_TYPES.WS_OPPONENT_JOINED, {
          challengeId:   msg.challenge_id,
          match_id:      msg.match_id,
          opponent_name: msg.opponent_name || 'Opponent' });
        break;

      case 'tiebreak_started':
        EventBus.emit(EVENT_TYPES.WS_TIEBREAK_STARTED, {
          parentMatchId: msg.parent_match_id, matchId: msg.match_id,
          challengeId: msg.challenge_id, arrow_count: msg.arrow_count,
          scoring: msg.scoring, distance: msg.distance, opponent_name: msg.opponent_name });
        break;

      // ── Challenge feed ──────────────────────────────────────────────────
      case 'new_challenge':
        EventBus.emit(EVENT_TYPES.WS_NEW_CHALLENGE, { challenge: msg.challenge });
        break;

      case 'challenge_removed':
        EventBus.emit(EVENT_TYPES.WS_CHALLENGE_REMOVED, { challenge_id: msg.challenge_id });
        break;

      case 'challenge_expired':
        EventBus.emit(EVENT_TYPES.WS_CHALLENGE_EXPIRED, {
          matchId: msg.match_id || null, challengeId: msg.challenge_id || null,
          you_lost: msg.you_lost, reason: msg.reason });
        break;

      // ── Rematch ─────────────────────────────────────────────────────────
      case 'match_ready':
        EventBus.emit(EVENT_TYPES.WS_MATCH_READY, {
          matchId: msg.match_id, challengeId: msg.challenge_id,
          opponent_name: msg.opponent_name, scoring: msg.scoring,
          distance: msg.distance, arrow_count: msg.arrow_count, match_type: msg.match_type });
        break;

      case 'rematch_proposed':
        EventBus.emit(EVENT_TYPES.WS_REMATCH_PROPOSED, {
          matchId: msg.match_id, proposed_by: msg.proposed_by,
          challengeId: msg.challenge_id, scoring: msg.scoring,
          distance: msg.distance, arrow_count: msg.arrow_count, match_type: msg.match_type });
        break;

      case 'rematch_accepted':
        EventBus.emit(EVENT_TYPES.WS_REMATCH_ACCEPTED, {
          matchId: msg.match_id, match_id: msg.match_id, challenge_id: msg.challenge_id,
          opponent_name: msg.opponent_name, scoring: msg.scoring,
          distance: msg.distance, arrow_count: msg.arrow_count, match_type: msg.match_type });
        break;

      case 'rematch_declined':
        EventBus.emit(EVENT_TYPES.WS_REMATCH_DECLINED, {
          matchId: msg.match_id, declined_by: msg.declined_by });
        break;

      // ── Matchmaking ─────────────────────────────────────────────────────
      case 'mm_status':
        EventBus.emit(EVENT_TYPES.WS_MM_STATUS, { message: msg.message });
        break;

      case 'mm_matched':
        EventBus.emit(EVENT_TYPES.WS_MM_MATCHED, {
          match_id: msg.match_id, opponent: msg.opponent });
        break;

      case 'mm_cancelled':
        EventBus.emit(EVENT_TYPES.WS_MM_CANCELLED, {});
        break;

      case 'pong':
        break; // keepalive — ignore

      default:
        console.debug('[WS] unhandled:', msg.type);
    }
  }

  // ── Open / close ───────────────────────────────────────────────────────────

  function _open() {
    if (_ws && (_ws.readyState === WebSocket.OPEN ||
                _ws.readyState === WebSocket.CONNECTING)) return;
    if (!STATE.accessToken) return;

    try {
      _ws = new WebSocket(_url());

      _ws.onopen = () => {
        _reconnectDelay = 1000;
        _startPing();
        EventBus.emit(EVENT_TYPES.WS_CONNECTED, { channel: 'user' });
      };

      _ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        _route(msg);
      };

      _ws.onerror = () => { /* onclose fires next */ };

      _ws.onclose = (ev) => {
        _stopPing();
        _ws = null;
        EventBus.emit(EVENT_TYPES.WS_DISCONNECTED, { channel: 'user', code: ev.code });
        if (!_intentional && STATE.accessToken) _scheduleReconnect();
      };

    } catch (err) {
      console.warn('[WS] open failed:', err);
      _scheduleReconnect();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function connect() {
    _intentional    = false;
    _reconnectDelay = 1000;
    _open();
  }

  function disconnect() {
    _intentional = true;
    _stopPing();
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_ws) { try { _ws.close(1000); } catch {} _ws = null; }
  }

  function reconnect() {
    disconnect();
    _intentional    = false;
    _reconnectDelay = 1000;
    _open();
  }

  function send(payload) {
    if (_ws?.readyState === WebSocket.OPEN) {
      _ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    } else {
      console.warn('[WS] send skipped — socket not open:', payload.type);
    }
  }

  function status() {
    if (!_ws) return 'closed';
    if (_ws.readyState === WebSocket.OPEN)       return 'open';
    if (_ws.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'closed';
  }

  return { connect, disconnect, reconnect, send, status };

})();

// ── Module-level helpers ──────────────────────────────────────────────────────

/** Send a match-scoped message (injects match_id automatically). */
function sendMatchMessage(payload, matchId = STATE.currentMatchId) {
  if (!matchId) return;
  WS.send({ ...payload, match_id: matchId });
}

/** Start matchmaking — sends mm_find with current filters and profile. */
function connectMatchmaking(profile) {
  WS.send({ type: 'mm_find', filters: STATE.filters, profile });
}

/** Cancel matchmaking. */
function disconnectMatchmaking() {
  WS.send({ type: 'mm_cancel' });
}
