// =============================================
// ARROWMATCH — Match State Management
// Start/complete/forfeit matches, multi-match helpers.
// Depends on: core/state.js, core/api.js, core/utils.js,
//             match/bot.js, match/websocket.js,
//             match/score-input.js, screens/history.js
// =============================================

// Per-match bot-fallback timers: { [matchId]: timerId }
const _botFallbackTimers = {};

function startMatch(challenge, isCreator = false) {
  const myName     = STATE.profile?.name || 'You';
  const oppName    = challenge.creator_name || challenge.name || 'Opponent';
  const scoring    = challenge.scoring    || 'total';
  const arrowCount = challenge.arrow_count || challenge.arrowCount || STATE.arrowCount || 18;
  const dist       = challenge.distance   || '30m';
  const matchId    = challenge.matchId    || challenge.id;

  const newMs = {
    id: matchId,
    challengeId: challenge.id,
    myName, oppName, scoring, arrowCount, dist,
    isBot:         challenge.isBot || false,
    arrowValues:   [],
    setMyScore:    0, setOppScore: 0, currentSet: 1, setArrowValues: [],
    complete:      false, isCreator,
  };
  STATE.activeMatches[matchId] = newMs;
  STATE.currentMatchId         = matchId;

  saveMatchState();
  _updateResumeTab();
  renderMatchScene();
  showScene('challenge');

  if (challenge.matchId && !challenge.isBot) {
    _connectMatchSocket(matchId);
  }
  if (isCreator && !challenge.isBot && challenge.matchId) {
    _scheduleBotFallback(challenge);
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

function saveMatchState() {
  const toSave = {};
  for (const [id, ms] of Object.entries(STATE.activeMatches)) {
    if (!ms.complete) toSave[id] = ms;
  }
  localStorage.setItem('arrowmatch_active_matches', JSON.stringify(toSave));
  localStorage.removeItem('arrowmatch_match_state'); // clear legacy key
}

function restoreMatch() {
  if (!STATE.matchState) return;
  renderMatchScene();
  arrowValues = [...STATE.matchState.arrowValues];
  refreshArrowCells();
}

// ── Multi-match helpers ───────────────────────────────────────────────────────

/** Remove a match: close its WS, cancel bot timer, persist. */
function _removeActiveMatch(matchId) {
  if (matchSockets[matchId]) {
    matchSockets[matchId].close();
    delete matchSockets[matchId];
  }
  if (_botFallbackTimers[matchId]) {
    clearTimeout(_botFallbackTimers[matchId]);
    delete _botFallbackTimers[matchId];
  }
  delete STATE.activeMatches[matchId];
  if (STATE.currentMatchId === matchId) {
    const remaining = Object.keys(STATE.activeMatches);
    STATE.currentMatchId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  saveMatchState();
  _updateResumeTab();
}

/** Sync resume tab visibility and count badge. */
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

/**
 * Switch the challenge scene to a different active match.
 * Saves in-progress arrow state for the current match first.
 */
function switchToMatch(matchId) {
  const ms = STATE.activeMatches[matchId];
  if (!ms)          { showToast('Match no longer active', 'error'); return; }
  if (ms.complete)  { showToast('That match has already finished', 'info'); return; }

  const cur = STATE.activeMatches[STATE.currentMatchId];
  if (cur && !cur.complete) {
    cur.arrowValues    = [...arrowValues];
    cur.setArrowValues = cur.scoring === 'sets' ? [...arrowValues] : cur.setArrowValues;
    saveMatchState();
  }

  STATE.currentMatchId = matchId;
  renderMatchScene();
  showScene('challenge');
}

// ── Forfeit ───────────────────────────────────────────────────────────────────

/**
 * Forfeit the current match.
 * Two-click confirmation, then POST /api/matches/:id/forfeit.
 */
async function forfeitMatch() {
  const ms = STATE.matchState;
  if (!ms || ms.complete) return;

  const btn = document.getElementById('forfeit-btn');
  if (!btn) return;

  if (btn.dataset.confirming !== 'true') {
    btn.textContent        = 'Confirm forfeit?';
    btn.dataset.confirming = 'true';
    btn.style.background   = 'rgba(242,96,96,0.25)';
    btn._resetTimer = setTimeout(() => {
      btn.textContent        = '✕ Forfeit';
      btn.dataset.confirming = 'false';
      btn.style.background   = '';
    }, 4000);
    return;
  }

  clearTimeout(btn._resetTimer);
  btn.textContent        = 'Forfeiting…';
  btn.disabled           = true;
  btn.dataset.confirming = 'false';

  if (ms.isBot) {
    showToast('You forfeited. Better luck next time!', 'info');
    completeMatch(0, 1, ms.id);
    return;
  }

  try {
    await api('POST', `/api/matches/${ms.id}/forfeit`);
    showToast('You forfeited. You lose this one.', 'info');
    completeMatch(0, 1, ms.id);
  } catch (e) {
    showToast(e.message || 'Forfeit failed — try again', 'error');
    btn.textContent = '✕ Forfeit';
    btn.disabled    = false;
  }
}

// ── Match completion ──────────────────────────────────────────────────────────

/**
 * Complete a match. Can be called for background matches (targetMatchId differs
 * from currentMatchId) — in that case only state/history are updated, no UI overlay.
 */
function completeMatch(myScore, oppScore, targetMatchId) {
  const mid = targetMatchId || STATE.currentMatchId;
  const ms  = STATE.activeMatches[mid];
  if (!ms) return;

  ms.complete      = true;
  ms.myFinalScore  = myScore;
  ms.oppFinalScore = oppScore;

  _removeActiveMatch(mid);
  saveToHistory(ms);

  // Only render result overlay for the currently displayed match
  if (mid !== STATE.currentMatchId) return;

  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }

  let icon, title;
  if (myScore > oppScore)      { icon = '🏆'; title = 'You Win!'; }
  else if (oppScore > myScore) { icon = '😤'; title = 'Better luck next time'; }
  else                          { icon = '🤝'; title = "It's a Draw!"; }

  const resultLine = ms.scoring === 'sets'
    ? `Set points: ${myScore}–${oppScore}`
    : `Score: ${myScore} vs ${oppScore}`;

  document.getElementById('complete-icon').textContent   = icon;
  document.getElementById('complete-title').textContent  = title;
  document.getElementById('complete-result').textContent = resultLine;
  document.getElementById('match-complete').classList.remove('hidden');
  _setNumpadDisabled(false);
  _setStatus('');

  const forfeitBtn = document.getElementById('forfeit-btn');
  if (forfeitBtn) forfeitBtn.classList.add('hidden');
}

function startRematch() {
  if (!STATE.matchState) return;
  const prev = STATE.matchState;
  document.getElementById('match-complete').classList.add('hidden');
  startMatch({
    id:         `rematch-${Date.now()}`,
    name:       prev.oppName,
    isBot:      prev.isBot,
    distance:   prev.dist,
    scoring:    prev.scoring,
    arrowCount: prev.arrowCount,
    type:       'live',
  });
}
