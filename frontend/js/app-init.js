// =============================================
// ARROWMATCH — App Init & Navigation
// Entry point, session restore, scene routing.
// Subscribes to APP_MATCH_STARTED and APP_SESSION_READY via EventBus.
// All navigation side-effects live here; no module calls showScene directly.
//
// Depends on: core/state.js, core/api.js, core/utils.js, core/event-bus.js,
//             match/match-state.js, match/ws-manager.js,
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
  // Navigate to match scene when a match starts
  EventBus.on(EVENT_TYPES.APP_MATCH_STARTED, ({ matchId, restored }) => {
    _updateResumeTab();
    if (!restored) showScene('challenge');
  });

  // Re-render resume tab whenever active matches change
  EventBus.on(EVENT_TYPES.APP_ACTIVE_MATCHES_CHANGED, () => {
    _updateResumeTab();
  });

  // Session ready — connect live feeds and restore state
  EventBus.on(EVENT_TYPES.APP_SESSION_READY, () => {
    connectChallengeFeed();
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

  // Notify interested components that the scene changed
  EventBus.emit(EVENT_TYPES.APP_SCENE_CHANGE, { scene: name });

  if (name === 'list-challenge') refreshChallengeList();
  if (name === 'my-challenges')  refreshMyChallenges();
  if (name === 'history')        refreshHistory();
  if (name === 'settings')       refreshSettings();
  if (name === 'new-challenge')  updateDeadlineVisibility();

  document.getElementById('back-btn').classList.toggle('hidden',
    !['challenge'].includes(name));
}

function goBack() { showScene('list-challenge'); }

function updateNavTitle() {
  const titles = {
    entry: '', settings: 'Settings',
    'list-challenge': 'ArrowMatch', 'new-challenge': 'New Challenge',
    'my-challenges': 'My Challenges', challenge: 'Match', history: 'History'
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

  if (savedMyCh)    STATE.myChallenges = JSON.parse(savedMyCh);
  if (savedHistory) STATE.history      = JSON.parse(savedHistory);

  const urlParams     = new URLSearchParams(window.location.search);
  const challengeCode = urlParams.get('c');

  if (savedUserId && savedAccess) {
    STATE.userId       = savedUserId;
    STATE.accessToken  = savedAccess;
    STATE.refreshToken = savedRefresh || null;
    if (savedUser)    STATE.user    = JSON.parse(savedUser);
    if (savedProfile) STATE.profile = JSON.parse(savedProfile);

    try {
      const serverProfile = await api('GET', '/api/profile');
      if (serverProfile) {
        STATE.profile = _serverProfileToLocal(serverProfile);
        localStorage.setItem('arrowmatch_profile', JSON.stringify(STATE.profile));
      }
    } catch (e) {
      if (e.status === 401) { _clearSession(); showScene('entry'); return; }
    }

    showUI();

    // Publish session ready — ws-manager and other modules connect their feeds
    EventBus.emit(EVENT_TYPES.APP_SESSION_READY, { userId: STATE.userId });

    if (challengeCode) {
      handleChallengeLink(challengeCode);
    } else {
      // Server is source of truth — restore active matches from it
      await restoreActiveMatchesFromServer();
    }
  } else {
    showScene('entry');
  }
}
