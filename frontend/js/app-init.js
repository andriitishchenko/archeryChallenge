// =============================================
// ARROWMATCH — App Init & Navigation
// Entry point, session restore, scene routing.
// Subscribes to APP_MATCH_STARTED and APP_SESSION_READY via EventBus.
//
// Depends on: core/state.js, core/api.js, core/utils.js, core/event-bus.js,
//             match/match-state.js,
//             screens/challenges.js, screens/settings.js, screens/history.js
// =============================================

document.addEventListener('DOMContentLoaded', init);

function init() {
  loadCountries();
  _registerNavigationSubscriptions();
  restoreSession();
  setupInviteMessageCounter();
}

// ── Navigation EventBus subscriptions ────────────────────────────────────────

function _registerNavigationSubscriptions() {
  EventBus.on(EVENT_TYPES.APP_MATCH_STARTED, ({ matchId, restored, background }) => {
    _updateResumeTab();
    if (!restored && !background) showScene('challenge');
  });

  EventBus.on(EVENT_TYPES.APP_ACTIVE_MATCHES_CHANGED, () => {
    _updateResumeTab();
  });

  EventBus.on(EVENT_TYPES.APP_SESSION_READY, () => {
    WS.connect();
  });

  EventBus.on(EVENT_TYPES.WS_OPP_SCORE_SUBMITTED, ({ matchId, opponent_name }) => {
    const ms = STATE.activeMatches[matchId];
    if (!ms) return;
    if (STATE.currentMatchId !== matchId && !ms._bgNotified) {
      ms._bgNotified = true;
      showToast(`${escHtml(opponent_name || ms.oppName || 'Opponent')} submitted their score!`, 'info');
      _updateResumeTab();
    }
  });

  EventBus.on(EVENT_TYPES.WS_OPPONENT_FORFEITED, ({ matchId, opponent_name }) => {
    const ms = STATE.activeMatches[matchId];
    if (!ms) return;
    if (STATE.currentMatchId !== matchId) {
      showToast(`${escHtml(opponent_name || 'Opponent')} forfeited — you win!`, 'success');
      _updateResumeTab();
    }
  });

  EventBus.on(EVENT_TYPES.WS_CHALLENGE_EXPIRED, ({ matchId, challengeId, you_lost, reason }) => {
    showToast(reason || (you_lost ? 'Time expired — you lost.' : 'Your opponent timed out — you win!'),
      you_lost ? 'error' : 'info');
    if (matchId && STATE.activeMatches[matchId]) {
      delete STATE.activeMatches[matchId];
      if (STATE.currentMatchId === matchId) {
        const remaining      = Object.keys(STATE.activeMatches);
        STATE.currentMatchId = remaining.length ? remaining[remaining.length - 1] : null;
      }
      _updateResumeTab();
      EventBus.emit(EVENT_TYPES.APP_ACTIVE_MATCHES_CHANGED, {
        activeMatches: STATE.activeMatches, currentMatchId: STATE.currentMatchId,
      });
    }
    if (STATE.currentScene === 'my-challenges') refreshMyChallenges();
  });
}

// ── Scene navigation ──────────────────────────────────────────────────────────

function showScene(name) {
  _updateResumeTab();
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scene === name);
  });
  document.querySelectorAll('.scene').forEach(s => s.classList.remove('active'));
  const scene = document.getElementById(`scene-${name}`);
  if (!scene) return;
  scene.classList.add('active');
  STATE.currentScene = name;
  updateNavTitle();

  EventBus.emit(EVENT_TYPES.APP_SCENE_CHANGE, { scene: name });

  if (name === 'settings')       refreshSettings();
  if (name === 'new-challenge')  updateDeadlineVisibility();
  if (name === 'challenge')      _refreshMatchScene();
  if (name === 'history')        refreshHistory();

  document.getElementById('back-btn').classList.toggle('hidden', name !== 'challenge');
}

function goBack() { showScene('list-challenge'); }

async function _refreshMatchScene() {
  const ms = STATE.matchState;
  if (!ms || ms.isBot || ms.id.startsWith('local-')) return;
  if (ms.id === ms.challengeId) {
    _setNumpadDisabled(true);
    _setStatus('Waiting for opponent to join…');
    return;
  }
  try {
    const status = await api('GET', `/api/matches/${ms.id}/status`);
    if (!status) return;

    if (status.status === 'waiting') {
      _setNumpadDisabled(true);
      _setStatus('Waiting for opponent to join…');
      return;
    }

    const isTiebreak = status.scoring === 'tiebreak';
    const isSets     = status.scoring === 'sets';

    // ── Restore authoritative server state into matchState ────────────────
    ms._tiebreakRequired = isTiebreak;
    ms.firstToAct        = status.first_to_act || ms.firstToAct;

    if (isTiebreak) {
      // Tiebreak: force 1-arrow total UI
      ms.arrowCount    = 1;
      ms.arrowValues   = [];
      arrowValues      = [null];
      activeArrowIndex = 0;
    } else if (isSets) {
      // Restore set scoreboard and current set from server
      ms.setMyScore  = status.my_set_points  ?? ms.setMyScore  ?? 0;
      ms.setOppScore = status.opp_set_points ?? ms.setOppScore ?? 0;
      ms.currentSet  = status.current_set    ?? ms.currentSet  ?? 1;
      // Clear any stale in-progress set arrows so the player starts the current set fresh
      ms.setArrowValues = [];
      arrowValues       = new Array(3).fill(null);
      activeArrowIndex  = 0;
    } else {
      // Total mode
      ms._totalMyScore = status.my_score ?? ms._totalMyScore;
    }

    saveMatchState();
    renderMatchScene();

    // ── Post-render status messages ───────────────────────────────────────
    if (isTiebreak) {
      ms._tiebreakSubmitted = status.my_submitted || false;
      if (status.my_submitted) {
        _setNumpadDisabled(true);
        _setStatus(status.opp_submitted
          ? 'Both submitted — calculating result…'
          : `Score submitted — waiting for ${escHtml(ms.oppName)}…`);
      } else if (status.opp_submitted) {
        _setNumpadDisabled(false);
        _setStatus(`${escHtml(ms.oppName)} already shot — shoot your arrow!`);
      }
    } else if (isSets) {
      // Restore opponent's already-submitted arrows for current set
      if (status.opp_current_set_arrows?.length) {
        ms._oppSetArrows = [...status.opp_current_set_arrows];
        _showOppSetLive(ms.oppName, ms._oppSetArrows);
      } else {
        ms._oppSetArrows = [];
      }

      if (status.my_submitted && !status.opp_submitted) {
        // I already submitted this set — lock numpad, wait for opponent
        arrowValues       = new Array(3).fill(null);
        ms.setArrowValues = [];
        activeArrowIndex  = 0;
        buildSetArrowRow();
        refreshSetArrowCells();
        _setNumpadDisabled(true);
        _setStatus(`Set ${ms.currentSet}: your arrows recorded — waiting for ${escHtml(ms.oppName)}…`);
      } else if (status.opp_submitted && !status.my_submitted) {
        _setNumpadDisabled(false);
        _setStatus(`${escHtml(ms.oppName)} already submitted set ${ms.currentSet} — shoot your arrows!`);
      } else {
        // Neither or both submitted — show judge instruction
        _setStatus(status.judge_status || '');
      }
    } else {
      // Total mode: my_score non-null means I already submitted
      if (status.my_score != null && !isTiebreak && status.status !== 'complete') {
        _setStatus(`Score submitted (${status.my_score}). Waiting for ${escHtml(ms.oppName)}…`);
        _setNumpadDisabled(true);
      }
    }
  } catch (e) {
    if (e?.status === 404) {
      const mid = STATE.currentMatchId;
      if (mid) _removeActiveMatch(mid);
      const remaining = Object.keys(STATE.activeMatches);
      remaining.length > 0
        ? switchToMatch(remaining[remaining.length - 1])
        : showScene('my-challenges');
      showToast('Match is no longer available', 'info');
    }
  }
}

function updateNavTitle() {
  const titles = {
    entry: '', settings: 'Settings',
    'list-challenge': 'ArrowMatch', 'new-challenge': 'New Challenge',
    'my-challenges': 'My Challenges', challenge: 'Match', history: 'History',
  };
  const el = document.getElementById('nav-title');
  if (el) el.textContent = titles[STATE.currentScene] || '';
  const isEntry = STATE.currentScene === 'entry';
  document.getElementById('topnav').classList.toggle('hidden', isEntry);
  document.getElementById('bottomnav').classList.toggle('hidden', isEntry);
}

function showUI() {
  document.getElementById('topnav').classList.remove('hidden');
  document.getElementById('bottomnav').classList.remove('hidden');
  updateNavTitle();
}

// ── Resume tab ────────────────────────────────────────────────────────────────

function _updateResumeTab() {
  const count = Object.values(STATE.activeMatches).filter(ms => !ms.complete).length;
  const tab   = document.getElementById('resume-tab');
  const badge = document.getElementById('match-count-badge');
  if (!tab) return;
  tab.classList.toggle('hidden', count === 0);
  if (badge) {
    badge.textContent = count > 1 ? count : '';
    badge.classList.toggle('hidden', count <= 1);
  }
}

// ── Session restore ───────────────────────────────────────────────────────────

async function restoreSession() {
  const savedUserId  = localStorage.getItem('arrowmatch_userid');
  const savedAccess  = localStorage.getItem('arrowmatch_access_token');
  const savedRefresh = localStorage.getItem('arrowmatch_refresh_token');
  const savedUser    = localStorage.getItem('arrowmatch_user');
  const savedProfile = localStorage.getItem('arrowmatch_profile');
  const savedMyCh    = localStorage.getItem('arrowmatch_my_challenges');
  const savedHistory = localStorage.getItem('arrowmatch_history');
  const safeParse    = (raw, fallback = null) => {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  };

  STATE.myChallenges = safeParse(savedMyCh, []);
  STATE.history      = safeParse(savedHistory, []);

  const urlParams     = new URLSearchParams(window.location.search);
  const challengeCode = urlParams.get('c');

  if (savedUserId && savedAccess) {
    STATE.userId       = savedUserId;
    STATE.accessToken  = savedAccess;
    STATE.refreshToken = savedRefresh || null;
    STATE.user         = safeParse(savedUser);
    STATE.profile      = safeParse(savedProfile);

    try {
      const me = await api('GET', '/api/auth/me');
      if (me) {
        STATE.user = { email: me.email, isGuest: me.is_guest };
        localStorage.setItem('arrowmatch_user', JSON.stringify(STATE.user));
      }
    } catch (e) {
      if (e.status === 401 || e.status === 404) {
        _clearSession(); _clearLocalChallengesAndMatches(); showScene('entry'); return;
      }
    }

    try {
      const serverProfile = await api('GET', '/api/profile');
      if (serverProfile) {
        STATE.profile = _serverProfileToLocal(serverProfile);
        localStorage.setItem('arrowmatch_profile', JSON.stringify(STATE.profile));
      }
    } catch (e) {
      if (e.status === 404) {
        STATE.profile = null; localStorage.removeItem('arrowmatch_profile');
      } else if (e.status === 401) {
        _clearSession(); _clearLocalChallengesAndMatches(); showScene('entry'); return;
      }
    }

    showUI();
    EventBus.emit(EVENT_TYPES.APP_SESSION_READY, { userId: STATE.userId });

    if (challengeCode) {
      handleChallengeLink(challengeCode);
    } else {
      await restoreActiveMatchesFromServer();
    }
  } else {
    showScene('entry');
  }
}

function _clearLocalChallengesAndMatches() {
  WS.disconnect();
  STATE.activeMatches  = {};
  STATE.currentMatchId = null;
  STATE.myChallenges   = [];
  STATE.challenges     = [];
  STATE.history        = [];
  localStorage.removeItem('arrowmatch_active_matches');
  localStorage.removeItem('arrowmatch_my_challenges');
  localStorage.removeItem('arrowmatch_history');
  localStorage.removeItem('arrowmatch_match_state');
}
