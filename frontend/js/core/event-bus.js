// =============================================
// ARROWMATCH — EventBus
// Global publish/subscribe hub.
// Server instructions arrive via WebSocket → published here → components react.
// No module imports anything directly from another module; all communication
// goes through this bus. Server state is the single source of truth.
// =============================================

const EventBus = (() => {
  // Map<eventName, Set<callback>>
  const _listeners = new Map();

  /**
   * Subscribe to an event.
   * @param {string}   event    Event name (see EVENT_TYPES)
   * @param {Function} callback Handler — receives the event payload
   * @returns {Function} Unsubscribe function
   */
  function on(event, callback) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(callback);
    // Return an unsubscribe handle so callers can clean up
    return () => off(event, callback);
  }

  /**
   * Unsubscribe a specific handler.
   */
  function off(event, callback) {
    _listeners.get(event)?.delete(callback);
  }

  /**
   * Publish an event to all subscribers.
   * Each handler runs in its own try/catch so one bad handler cannot break
   * the rest of the chain.
   *
   * @param {string} event   Event name
   * @param {*}      payload Data to deliver
   */
  function emit(event, payload) {
    const handlers = _listeners.get(event);
    if (!handlers || handlers.size === 0) return;
    for (const cb of handlers) {
      try { cb(payload); }
      catch (err) { console.error(`[EventBus] handler error on "${event}":`, err); }
    }
  }

  /**
   * Subscribe to an event and auto-unsubscribe after the first call.
   */
  function once(event, callback) {
    const unsub = on(event, (payload) => {
      unsub();
      callback(payload);
    });
    return unsub;
  }

  return { on, off, emit, once };
})();

// ── Canonical event names ─────────────────────────────────────────────────────
// All WebSocket message types the server can push are listed here.
// Application events (UI-only) use the "app:" prefix.
const EVENT_TYPES = Object.freeze({
  // ── Server → Client (WebSocket push) ──────────────────────────────────────
  // Challenge feed
  WS_NEW_CHALLENGE:         'ws:new_challenge',
  WS_CHALLENGE_REMOVED:     'ws:challenge_removed',

  // Match lifecycle
  WS_OPPONENT_JOINED:       'ws:opponent_joined',
  WS_OPPONENT_DISCONNECTED: 'ws:opponent_disconnected',
  WS_OPPONENT_FORFEITED:    'ws:opponent_forfeited',

  // Live scoring
  WS_OPP_ARROW:             'ws:opp_arrow',
  WS_OPP_SET_DONE:          'ws:opp_set_done',
  WS_OPP_TIEBREAK_DONE:     'ws:opp_tiebreak_done',
  WS_OPP_SCORE_DONE:        'ws:opp_score_done',

  // Rematch
  WS_REMATCH_PROPOSED:      'ws:rematch_proposed',
  WS_REMATCH_ACCEPTED:      'ws:rematch_accepted',
  WS_REMATCH_DECLINED:      'ws:rematch_declined',

  // Matchmaking
  WS_MM_STATUS:             'ws:mm_status',
  WS_MM_MATCHED:            'ws:mm_matched',

  // Connection state
  WS_CONNECTED:             'ws:connected',
  WS_DISCONNECTED:          'ws:disconnected',
  WS_ERROR:                 'ws:error',

  // ── Application events (client-side only) ──────────────────────────────────
  APP_SESSION_READY:        'app:session_ready',
  APP_SESSION_CLEARED:      'app:session_cleared',
  APP_SCENE_CHANGE:         'app:scene_change',
  APP_MATCH_STARTED:        'app:match_started',
  APP_MATCH_COMPLETE:       'app:match_complete',
  APP_MATCH_SWITCHED:       'app:match_switched',
  APP_PROFILE_SAVED:        'app:profile_saved',
  APP_CHALLENGES_UPDATED:   'app:challenges_updated',
  APP_MY_CHALLENGES_UPDATED:'app:my_challenges_updated',
  APP_HISTORY_UPDATED:      'app:history_updated',
  APP_ACTIVE_MATCHES_CHANGED:'app:active_matches_changed',
});
