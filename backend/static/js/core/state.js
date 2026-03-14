// =============================================
// ARROWMATCH — Global State & Config
// Loaded first. All other modules read from STATE.
// =============================================

// ── Config ───────────────────────────────────────────────────────────────────
const API_BASE = '';   // same-origin
const WS_BASE  = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;

// ── Application state ────────────────────────────────────────────────────────
const STATE = {
  userId:       null,
  accessToken:  null,
  refreshToken: null,
  user:         null,    // { email, isGuest }
  profile:      null,    // { name, gender, age, bowType, skillLevel, country }
  currentScene: 'entry',
  activeChallengeId: null,
  currentMatchType:  'live',
  currentScoring:    'total',
  arrowCount:        18,
  // Multi-match: { [matchId]: matchState }
  activeMatches:  {},
  currentMatchId: null,
  challenges:     [],
  myChallenges:   [],
  history:        [],
  filters: {
    skill:   ['Beginner', 'Skilled', 'Master'],
    gender:  ['Male', 'Female'],
    bow:     ['Recurve', 'Compound', 'Barebow'],
    dist:    ['18m', '25m', '30m', '50m', '70m', '90m'],
    country: ''
  }
};

// Convenience accessor — STATE.matchState ↔ activeMatches[currentMatchId]
Object.defineProperty(STATE, 'matchState', {
  get() { return STATE.activeMatches[STATE.currentMatchId] ?? null; },
  set(v) {
    if (v && v.id) {
      STATE.activeMatches[v.id] = v;
      STATE.currentMatchId = v.id;
    }
  }
});

// ── Score-input globals (owned by match/score-input.js, declared here so all
//    modules can read arrowValues without circular imports) ───────────────────
let activeArrowIndex = 0;
let arrowValues      = [];

// ── WebSocket maps ────────────────────────────────────────────────────────────
// matchSockets: { [matchId]: WebSocket }  — owned by match/websocket.js
const matchSockets = {};

// window.matchSocket — backwards-compatible alias
Object.defineProperty(window, 'matchSocket', {
  get() { return matchSockets[STATE.currentMatchId] ?? null; },
  set(v) {
    if (v === null && STATE.currentMatchId) {
      delete matchSockets[STATE.currentMatchId];
    } else if (v && STATE.currentMatchId) {
      matchSockets[STATE.currentMatchId] = v;
    }
  }
});

let mmSocket = null;   // matchmaking WebSocket — owned by match/websocket.js
