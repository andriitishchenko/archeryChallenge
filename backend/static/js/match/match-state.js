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
  _resetRematchUI();
  showScene('challenge');

  if (challenge.matchId && !challenge.isBot) {
    _connectMatchSocket(matchId);
    _startBgStatusPoll(); // ensure background status monitoring is active
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
    _forfeitAndExit(ms);
    return;
  }

  try {
    await api('POST', `/api/matches/${ms.id}/forfeit`);
    showToast('You forfeited. Better luck next time!', 'info');
    _forfeitAndExit(ms);
  } catch (e) {
    showToast(e.message || 'Forfeit failed — try again', 'error');
    btn.textContent = '✕ Forfeit';
    btn.disabled    = false;
  }
}

/**
 * Finalise a forfeited match: record the result, remove from active matches,
 * close the waiting socket if open, and navigate to My Challenges.
 */
function _forfeitAndExit(ms) {
  ms.complete      = true;
  ms.myFinalScore  = 0;
  ms.oppFinalScore = 1;

  if (typeof closeCreatorWaitSocket === 'function') closeCreatorWaitSocket();

  _removeActiveMatch(ms.id);
  saveToHistory(ms);
  showScene('my-challenges');
}

// ── Match completion ──────────────────────────────────────────────────────────

/**
 * Complete a match. Can be called for background matches (targetMatchId differs
 * from currentMatchId) — in that case only state/history are updated, no UI overlay.
 */
function completeMatch(myScore, oppScore, targetMatchId) {
  const mid        = targetMatchId || STATE.currentMatchId;
  const ms         = STATE.activeMatches[mid];
  if (!ms) return;

  // Capture whether this is the displayed match BEFORE _removeActiveMatch
  // reassigns STATE.currentMatchId to the next available match.
  const wasDisplayed = (mid === STATE.currentMatchId);

  ms.complete      = true;
  ms.myFinalScore  = myScore;
  ms.oppFinalScore = oppScore;

  _removeActiveMatch(mid);
  saveToHistory(ms);

  // Restart background poller if other non-bot matches are still active
  const hasMoreServerMatches = Object.values(STATE.activeMatches).some(
    m => !m.complete && !m.isBot && m.id && !m.id.startsWith('local-')
  );
  if (hasMoreServerMatches) _startBgStatusPoll();

  // Only render result overlay for the currently displayed match
  if (!wasDisplayed) return;

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

// ── Rematch flow ──────────────────────────────────────────────────────────────

/**
 * Called when the current user clicks "Rematch" after a completed match.
 * POSTs to /api/matches/{id}/rematch — server creates a cloned challenge,
 * pushes 'rematch_proposed' WS to opponent.
 * Client shows a waiting state until opponent responds.
 */
async function proposeRematch() {
  const ms = STATE.matchState;
  if (!ms) return;

  // Bot rematch: skip server, start immediately
  if (ms.isBot) {
    _startBotRematch(ms);
    return;
  }

  const actionsEl  = document.getElementById('complete-actions');
  const pendingEl  = document.getElementById('rematch-pending');
  actionsEl.classList.add('hidden');
  pendingEl.classList.remove('hidden');

  try {
    await api('POST', `/api/matches/${ms.id}/rematch`);
    // Server pushes rematch_proposed to opponent via WS.
    // We stay in the pending state until rematch_accepted or rematch_declined arrives.
  } catch (e) {
    showToast(e.message || 'Could not propose rematch', 'error');
    actionsEl.classList.remove('hidden');
    pendingEl.classList.add('hidden');
  }
}

/**
 * Called when the opponent clicks "Accept" on the rematch request panel.
 * POSTs to /api/matches/{id}/rematch/accept — server creates the new match,
 * returns new_match_id + challenge config, pushes 'rematch_accepted' to proposer.
 */
async function acceptRematch() {
  const ms = STATE.matchState;
  if (!ms) return;

  const requestEl = document.getElementById('rematch-request');
  requestEl.classList.add('hidden');

  try {
    const data = await api('POST', `/api/matches/${ms.id}/rematch/accept`);
    if (data?.new_match_id) {
      _launchRematchMatch(data, ms);
    }
  } catch (e) {
    showToast(e.message || 'Could not accept rematch', 'error');
    requestEl.classList.remove('hidden');
  }
}

/**
 * Called when the opponent clicks "Decline" on the rematch request panel.
 */
async function declineRematch() {
  const ms = STATE.matchState;
  if (!ms) return;

  document.getElementById('rematch-request').classList.add('hidden');
  document.getElementById('complete-actions').classList.remove('hidden');

  try {
    await api('POST', `/api/matches/${ms.id}/rematch/decline`);
    showToast('Rematch declined', 'info');
  } catch {}
}

/**
 * Show the rematch-request panel to the opponent (called from WS handler).
 * matchId = original match id, proposerName = who proposed it.
 */
function _showRematchRequest(matchId, proposerName) {
  // Only relevant if the completed match is still displayed
  const ms = STATE.activeMatches[matchId] || STATE.matchState;
  if (!ms) return;

  const requestEl  = document.getElementById('rematch-request');
  const textEl     = document.getElementById('rematch-request-text');
  const actionsEl  = document.getElementById('complete-actions');

  if (!requestEl) return;

  if (textEl) textEl.textContent = `${proposerName} wants a rematch!`;
  actionsEl.classList.add('hidden');
  requestEl.classList.remove('hidden');
}

/**
 * Launch a new match from a rematch_accepted server response.
 * @param {object} data  Server response with new_match_id, challenge config fields
 * @param {object} prev  Previous match state (for scoring defaults)
 */
function _launchRematchMatch(data, prev) {
  document.getElementById('match-complete').classList.add('hidden');
  startMatch({
    id:         data.new_challenge_id || `rematch-${Date.now()}`,
    matchId:    data.new_match_id,
    name:       data.opponent_name || prev.oppName,
    scoring:    data.scoring       || prev.scoring,
    distance:   data.distance      || prev.dist,
    arrowCount: data.arrow_count   || prev.arrowCount,
    match_type: data.match_type    || 'private',
  });
}

/** Bot rematch — no server call needed. */
function _startBotRematch(prev) {
  document.getElementById('match-complete').classList.add('hidden');
  startMatch({
    id:         `rematch-${Date.now()}`,
    name:       prev.oppName,
    isBot:      true,
    distance:   prev.dist,
    scoring:    prev.scoring,
    arrowCount: prev.arrowCount,
  });
}

/** Reset rematch UI panels back to default after a new match starts. */
function _resetRematchUI() {
  const actionsEl = document.getElementById('complete-actions');
  const pendingEl = document.getElementById('rematch-pending');
  const requestEl = document.getElementById('rematch-request');
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (pendingEl) pendingEl.classList.add('hidden');
  if (requestEl) requestEl.classList.add('hidden');
}
