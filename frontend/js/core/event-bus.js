// =============================================
// ARROWMATCH — EventBus
// Global publish/subscribe hub.
// Server events arrive via WebSocket → published here → components react.
// No module imports anything directly from another module.
// =============================================

const EventBus = (() => {
  const _listeners = new Map();

  function on(event, callback) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(callback);
    return () => off(event, callback);
  }

  function off(event, callback) {
    _listeners.get(event)?.delete(callback);
  }

  function emit(event, payload) {
    const handlers = _listeners.get(event);
    if (!handlers || handlers.size === 0) return;
    for (const cb of [...handlers]) {
      try { cb(payload); }
      catch (err) { console.error(`[EventBus] handler error on "${event}":`, err); }
    }
  }

  function once(event, callback) {
    const unsub = on(event, (payload) => { unsub(); callback(payload); });
    return unsub;
  }

  return { on, off, emit, once };
})();

// ── Canonical event names ─────────────────────────────────────────────────────
const EVENT_TYPES = Object.freeze({
  // ── Server → Client (WebSocket push) ──────────────────────────────────────

  // Challenge feed
  WS_NEW_CHALLENGE:         'ws:new_challenge',
  WS_CHALLENGE_REMOVED:     'ws:challenge_removed',
  WS_CHALLENGE_EXPIRED:     'ws:challenge_expired',

  // Match lifecycle
  WS_OPPONENT_JOINED:       'ws:opponent_joined',
  WS_OPPONENT_DISCONNECTED: 'ws:opponent_disconnected',
  WS_OPPONENT_FORFEITED:    'ws:opponent_forfeited',
  WS_MATCH_COMPLETE:        'ws:match_complete',

  // Live scoring
  WS_OPP_ARROW:             'ws:opp_arrow',
  WS_OPP_SET_DONE:          'ws:opp_set_done',
  WS_OPP_TIEBREAK_DONE:     'ws:opp_tiebreak_done',
  WS_OPP_SCORE_DONE:        'ws:opp_score_done',
  WS_OPP_SCORE_SUBMITTED:   'ws:opp_score_submitted',
  WS_SET_RESOLVED:          'ws:set_resolved',
  WS_TIEBREAK_STARTED:      'ws:tiebreak_started',

  // Rematch
  WS_MATCH_READY:           'ws:match_ready',
  WS_REMATCH_PROPOSED:      'ws:rematch_proposed',
  WS_REMATCH_ACCEPTED:      'ws:rematch_accepted',
  WS_REMATCH_DECLINED:      'ws:rematch_declined',

  // Matchmaking
  WS_MM_STATUS:             'ws:mm_status',
  WS_MM_CANCELLED:          'ws:mm_cancelled',
  WS_MM_MATCHED:            'ws:mm_matched',

  // Connection state
  WS_CONNECTED:             'ws:connected',
  WS_DISCONNECTED:          'ws:disconnected',
  WS_ERROR:                 'ws:error',

  // ── Application events (client-side only) ──────────────────────────────────

  // Session / navigation
  APP_SESSION_READY:          'app:session_ready',
  APP_SCENE_CHANGE:           'app:scene_change',
  APP_PROFILE_SAVED:          'app:profile_saved',

  // Match lifecycle
  APP_MATCH_STARTED:          'app:match_started',
  APP_MATCH_COMPLETE:         'app:match_complete',
  APP_MATCH_SWITCHED:         'app:match_switched',
  APP_ACTIVE_MATCHES_CHANGED: 'app:active_matches_changed',

  // Forfeit flow (two-step confirm handled in score-input.js)
  APP_FORFEIT_REQUESTED:      'app:forfeit_requested',
  APP_FORFEIT_CONFIRMED:      'app:forfeit_confirmed',
  APP_FORFEIT_FAILED:         'app:forfeit_failed',

  // Rematch overlay state — emitted by match-state.js; handled by score-input.js
  APP_REMATCH_PENDING:        'app:rematch_pending',
  APP_REMATCH_PENDING_CANCEL: 'app:rematch_pending_cancel',
  APP_REMATCH_ACCEPTED_LOCAL: 'app:rematch_accepted_local',
  APP_REMATCH_ACCEPTED_FAIL:  'app:rematch_accepted_fail',
  APP_REMATCH_DECLINED_LOCAL: 'app:rematch_declined_local',
  APP_REMATCH_OVERLAY_HIDE:   'app:rematch_overlay_hide',
  APP_REMATCH_ACTIONS_SHOW:   'app:rematch_actions_show',
  APP_SHOW_REMATCH_REQUEST:   'app:show_rematch_request',

  // UI helpers
  APP_OPP_NAME_UPDATE:        'app:opp_name_update',

  // Data updates
  APP_CHALLENGES_UPDATED:     'app:challenges_updated',
  APP_MY_CHALLENGES_UPDATED:  'app:my_challenges_updated',
  APP_HISTORY_UPDATED:        'app:history_updated',
});
