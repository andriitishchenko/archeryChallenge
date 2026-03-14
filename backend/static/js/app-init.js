// =============================================
// ARROWMATCH — App Init & Navigation
// Entry point, session restore, scene routing.
// Depends on: core/state.js, core/api.js, core/utils.js,
//             match/match-state.js, screens/challenges.js,
//             screens/settings.js, screens/history.js
// =============================================

document.addEventListener('DOMContentLoaded', init);

// Background poller interval reference (checks all active non-bot matches)
let _bgStatusPollInterval = null;

function init() {
  loadCountries();
  restoreSession();
  setupInviteMessageCounter();
}

// ── Background match status polling ──────────────────────────────────────────

/**
 * Start the background poller that checks status for every registered
 * (non-bot, non-complete) match.  Called once after session is restored
 * and whenever a new server-backed match is started.
 *
 * For each match it polls GET /api/matches/:id/status and:
 *   - status === "complete"  → call completeMatch() with server scores
 *   - HTTP 404               → match was removed; exit MATCH screen if active
 */
function _startBgStatusPoll() {
  if (_bgStatusPollInterval) return; // already running

  _bgStatusPollInterval = setInterval(_bgPollTick, 5000);
}

function _stopBgStatusPoll() {
  if (_bgStatusPollInterval) {
    clearInterval(_bgStatusPollInterval);
    _bgStatusPollInterval = null;
  }
}

async function _bgPollTick() {
  // Collect all active, non-bot, server-backed matches
  const matchEntries = Object.entries(STATE.activeMatches).filter(
    ([, ms]) => !ms.complete && !ms.isBot && ms.id && !ms.id.startsWith('local-')
  );

  if (matchEntries.length === 0) {
    _stopBgStatusPoll();
    return;
  }

  for (const [matchId, ms] of matchEntries) {
    // Skip matches that already have an active dedicated poll running
    // (_polling flag is set by total-mode while waiting for opponent score)
    if (ms._polling) continue;

    try {
      const status = await api('GET', `/api/matches/${ms.id}/status`);
      if (!status) continue;

      // Match finished on server side
      if (status.status === 'complete' && status.result) {
        const myScore  = status.my_score  ?? 0;
        const oppScore = status.opp_score ?? 0;
        completeMatch(myScore, oppScore, matchId);
        continue;
      }

      // Tiebreak — only relevant if this is the current visible match and
      // the user has already submitted (total mode). Don't auto-complete.
      // The dedicated _pollForResult in total-mode.js handles this path.

    } catch (err) {
      // 404 → match removed or expired on server
      if (err && err.status === 404) {
        const isActive = STATE.currentMatchId === matchId;
        _removeActiveMatch(matchId);
        if (isActive && STATE.currentScene === 'challenge') {
          showToast('Match is no longer available', 'info');
          const remaining = Object.keys(STATE.activeMatches);
          if (remaining.length > 0) {
            switchToMatch(remaining[remaining.length - 1]);
          } else {
            showScene('list-challenge');
          }
        } else if (isActive) {
          showToast('Match is no longer available', 'info');
        }
      }
    }
  }
}

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

    // Connect real-time challenge list feed
    connectChallengeFeed();

    if (challengeCode) {
      handleChallengeLink(challengeCode);
    } else {
      // Restore active matches from server (authoritative source).
      // localStorage is a fallback for arrow values already entered this session.
      await _restoreActiveMatchesFromServer();
    }
  } else {
    showScene('entry');
  }
}

function showUI() {
  document.getElementById('topnav').classList.remove('hidden');
  document.getElementById('bottomnav').classList.remove('hidden');
  updateNavTitle();
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

// ── Server-authoritative match restore ───────────────────────────────────────

/**
 * On page load, fetch GET /api/matches/mine/active from the server.
 * This is the authoritative source — both creator and joiner see their matches.
 * Merge with localStorage arrow values so partially-entered scores survive reload.
 */
async function _restoreActiveMatchesFromServer() {
  let serverMatches = [];
  try {
    serverMatches = await api('GET', '/api/matches/mine/active') || [];
  } catch {
    // Offline — fall back to localStorage only
    serverMatches = [];
  }

  // Load any locally-saved arrow progress (arrow values entered but not yet submitted)
  const savedLocal = {};
  try {
    const raw = localStorage.getItem('arrowmatch_active_matches');
    if (raw) {
      const map = JSON.parse(raw);
      for (const [id, ms] of Object.entries(map)) {
        if (!ms.complete) savedLocal[id] = ms;
      }
    }
  } catch {}

  // Build STATE.activeMatches from server matches, merging in local arrow progress
  for (const sm of serverMatches) {
    const local = savedLocal[sm.match_id] || {};
    STATE.activeMatches[sm.match_id] = {
      id:            sm.match_id,
      challengeId:   sm.challenge_id,
      myName:        STATE.profile?.name || 'You',
      oppName:       sm.opponent_name,
      scoring:       sm.scoring,
      arrowCount:    sm.arrow_count || 18,
      dist:          sm.distance,
      isBot:         false,
      isCreator:     sm.is_creator,
      complete:      false,
      // Preserve any arrow values the user had entered before reload
      arrowValues:    local.arrowValues    || [],
      setArrowValues: local.setArrowValues || [],
      setMyScore:     local.setMyScore     || 0,
      setOppScore:    local.setOppScore    || 0,
      currentSet:     local.currentSet     || 1,
    };
    // Re-open the per-match WS so live updates resume
    _connectMatchSocket(sm.match_id);
  }

  const restoredCount = serverMatches.length;

  // Also pick up any bot/local matches that only live in localStorage
  for (const [id, ms] of Object.entries(savedLocal)) {
    if (!STATE.activeMatches[id] && !ms.complete) {
      STATE.activeMatches[id] = ms;
    }
  }

  if (restoredCount > 0) {
    const ids = Object.keys(STATE.activeMatches);
    STATE.currentMatchId = ids[ids.length - 1];
    _updateResumeTab();
    showScene('challenge');
    restoreMatch();
    showToast(`${restoredCount} active match${restoredCount > 1 ? 'es' : ''} restored`, 'info');
    _startBgStatusPoll();
  } else if (Object.keys(STATE.activeMatches).length > 0) {
    // Only local/bot matches
    const ids = Object.keys(STATE.activeMatches);
    STATE.currentMatchId = ids[ids.length - 1];
    _updateResumeTab();
    showScene('challenge');
    restoreMatch();
  } else {
    showScene('list-challenge');
  }
}
