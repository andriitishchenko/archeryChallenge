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

    // Restore active matches — new multi-match key, with legacy migration
    const savedActiveMatches = localStorage.getItem('arrowmatch_active_matches');
    const savedLegacyMatch   = localStorage.getItem('arrowmatch_match_state');
    let restoredCount = 0;

    if (savedActiveMatches) {
      try {
        const map = JSON.parse(savedActiveMatches);
        for (const [id, ms] of Object.entries(map)) {
          if (!ms.complete) { STATE.activeMatches[id] = ms; restoredCount++; }
        }
      } catch {}
    } else if (savedLegacyMatch) {
      try {
        const ms = JSON.parse(savedLegacyMatch);
        if (ms && ms.id && !ms.complete) {
          STATE.activeMatches[ms.id] = ms;
          restoredCount++;
          localStorage.removeItem('arrowmatch_match_state');
        }
      } catch {}
    }

    if (challengeCode) {
      handleChallengeLink(challengeCode);
    } else if (restoredCount > 0) {
      const ids = Object.keys(STATE.activeMatches);
      STATE.currentMatchId = ids[ids.length - 1];
      _updateResumeTab();
      showScene('challenge');
      restoreMatch();
      showToast(`${restoredCount} active match${restoredCount > 1 ? 'es' : ''} restored`, 'info');
      _startBgStatusPoll(); // monitor all restored matches for completion/removal
    } else {
      showScene('list-challenge');
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
