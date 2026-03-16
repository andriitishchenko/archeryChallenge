// =============================================
// ARROWMATCH — Global State & Config
// Loaded first. Components READ from STATE; only dedicated managers WRITE to it.
// Mutations that affect other modules always go through EventBus.emit().
// =============================================

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = '';  // same-origin
const WS_BASE  = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;

// ── Application state ─────────────────────────────────────────────────────────
const STATE = {
  userId:       null,
  accessToken:  null,
  refreshToken: null,
  user:         null,   // { email, isGuest }
  profile:      null,   // { name, gender, age, bowType, skillLevel, country }
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
  history:            [],
  lastCompletedMatch: null,   // preserved after match ends so rematch flow can reference it
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

// ── Score-input globals ───────────────────────────────────────────────────────
// Owned by match/score-input.js; declared here so all modules share the same ref.
let activeArrowIndex = 0;
let arrowValues      = [];
