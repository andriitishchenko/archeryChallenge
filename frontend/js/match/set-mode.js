// =============================================
// ARROWMATCH — Set-System Mode
// 3 arrows per set → server decides winner → next set or 5:5 shoot-off.
//
// Depends on: core/state.js, core/api.js, core/event-bus.js,
//             match/match-state.js, match/score-input.js, match/bot.js
// =============================================

const _setTiebreakPollTimers = {};
const _setResolutionPollTimers = {};

function _scheduleSetResolutionRecovery(matchId, attempt = 0) {
  if (_setResolutionPollTimers[matchId]) return;
  _setResolutionPollTimers[matchId] = setTimeout(async () => {
    delete _setResolutionPollTimers[matchId];
    const ms = STATE.activeMatches[matchId];
    if (!ms || ms.complete || ms._pendingSetNumber === undefined || attempt >= 60) return;
    await _fetchAndResolveMatch(matchId);
    const current = STATE.activeMatches[matchId];
    if (current && !current.complete && current._pendingSetNumber !== undefined) {
      _scheduleSetResolutionRecovery(matchId, attempt + 1);
    }
  }, 1000);
}

function _scheduleSetTiebreakRecovery(matchId, attempt = 0) {
  if (_setTiebreakPollTimers[matchId]) return;
  _setTiebreakPollTimers[matchId] = setTimeout(async () => {
    delete _setTiebreakPollTimers[matchId];
    const ms = STATE.activeMatches[matchId];
    if (!ms || ms.complete || !ms._pendingTiebreak || attempt >= 60) return;
    await _fetchAndResolveMatch(matchId);
    const current = STATE.activeMatches[matchId];
    if (current && !current.complete && current._pendingTiebreak) {
      _scheduleSetTiebreakRecovery(matchId, attempt + 1);
    }
  }, 1000);
}

// Opponent finished their set — update the waiting state without resubmitting.
EventBus.on(EVENT_TYPES.WS_OPP_SET_DONE, ({ matchId, set_number, set_total }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (!ms) return;

  if (ms._pendingSetNumber !== undefined) {
    // The opponent's submission resolves the set on the server. Do not resend
    // our already-cleared input; that used to POST arrows: [] and produce 422.
    if (ms.complete) delete ms._pendingSetNumber;
    if (isActive) {
      _setNumpadDisabled(true);
      _setStatus(`Set ${set_number || ms._pendingSetNumber}: both submissions received — calculating result…`);
    }
    // Recover the authoritative next set when both near-simultaneous POSTs
    // missed each other's rows and no set_resolved event was emitted.
    _fetchAndResolveMatch(matchId);
    _scheduleSetResolutionRecovery(matchId);
  } else if (isActive) {
    const totalStr = set_total !== undefined ? ` (${set_total} pts)` : '';
    _setStatus(`${escHtml(ms.oppName)} submitted set ${set_number || ''}${totalStr} — waiting for your arrows…`);
    _setNumpadDisabled(false);
  } else {
    showToast(`${escHtml(ms.oppName || 'Opponent')} submitted set ${set_number || ''}.`, 'info');
    _fetchAndResolveMatch(matchId);
  }
});

// Live scoreboard update when both players submitted a set
EventBus.on(EVENT_TYPES.WS_SET_RESOLVED, ({ matchId, set_number, scores, winner_id, next_first }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (!ms || !scores) return;

  const myId    = STATE.userId;
  const myData  = scores[myId]  || { total: 0, pts: 0 };
  const oppId   = Object.keys(scores).find(id => id !== myId);
  const oppData = oppId ? (scores[oppId] || { total: 0, pts: 0 }) : { total: 0, pts: 0 };

  ms.setMyScore = myData.pts;
  ms.setOppScore = oppData.pts;
  ms.currentSet  = set_number + 1;
  ms.firstToAct  = next_first;
  saveMatchState();

  if (isActive) {
    refreshSetScore();
    _showOppSetArrows(oppData.total, []);
    const youWon  = winner_id === myId;
    const oppWon  = winner_id && winner_id !== myId;
    const label   = youWon ? 'You win this set!'
                  : oppWon ? `${escHtml(ms.oppName)} wins this set`
                  :           'Set drawn — 1 pt each';
    const youFirst = next_first === myId;
    const nextMsg  = youFirst
      ? 'You shoot first next set.'
      : `${escHtml(ms.oppName)} shoots first next set.`;
    _setStatus(`Set ${set_number}: ${myData.total}–${oppData.total} — ${label}  [${myData.pts}:${oppData.pts}]  ${nextMsg}`);
    // Brief pause so player reads the result before cells reset
    setTimeout(() => _nextSet(set_number), 1500);
  }
});

// Set-system sudden death starts on the server when five sets finish tied.
// The event is also needed by a player who has already left the match screen.
EventBus.on(EVENT_TYPES.WS_SET_TIEBREAK_STARTED, ({ matchId, scores, next_first }) => {
  const ms = STATE.activeMatches[matchId];
  if (!ms) return;

  ms._tiebreak = true;
  ms._pendingTiebreak = false;
  if (scores) {
    const myData = scores[STATE.userId];
    const oppId = Object.keys(scores).find(id => id !== STATE.userId);
    const oppData = oppId ? scores[oppId] : null;
    if (myData) ms.setMyScore = myData.pts;
    if (oppData) ms.setOppScore = oppData.pts;
  }
  if (next_first) ms.firstToAct = next_first;
  saveMatchState();
  if (STATE.currentMatchId === matchId) {
    _startTiebreak();
  } else {
    showToast(`${escHtml(ms.oppName || 'Opponent')} — sudden death started.`, 'info');
  }
  // The event is a fast notification, while /status is authoritative. A
  // client can receive this event after a stale local set score was rendered;
  // refresh immediately so both scoreboards show the same 5:5 state.
  _fetchAndResolveMatch(matchId);
});

// Opponent finished their tiebreak arrow
EventBus.on(EVENT_TYPES.WS_OPP_TIEBREAK_DONE, ({ matchId }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (!ms) return;

  // The opponent's arrow unlocks this round for us. Never submit a second
  // copy of our arrow from this notification.
  if (ms._pendingTiebreak) {
    ms._pendingTiebreak = true;
    if (isActive) {
      _setNumpadDisabled(true);
      _setStatus(`Tiebreak: both arrows received — calculating result…`);
    }
    _scheduleSetTiebreakRecovery(matchId);
    return;
  }
  if (isActive) {
    _setNumpadDisabled(false);
    _setStatus(`${escHtml(ms.oppName)} already shot — shoot your arrow!`);
  } else {
    showToast(`${escHtml(ms.oppName || 'Opponent')} shot a sudden-death arrow.`, 'info');
  }
});

// ── Set resolution ────────────────────────────────────────────────────────────

async function resolveSet() {
  const ms = STATE.matchState;
  if (!ms || ms._setSubmitting) return;
  if (!ms.isBot && ms.id === ms.challengeId) {
    _setStatus('Waiting for opponent to join before you can submit…');
    return;
  }

  ms._setSubmitting = true;
  const myArrows  = arrowValues.filter(v => v !== null);

  // Guard: all arrows must be filled before submitting
  if (myArrows.length === 0 || myArrows.length < arrowValues.length) {
    ms._setSubmitting = false;
    return;
  }

  const myTotal   = myArrows.reduce((a, b) => a + b, 0);
  const setNumber = ms.currentSet;

  _setNumpadDisabled(true);
  _setStatus(`Set ${setNumber}: waiting for opponent…`);

  if (ms.isBot) {
    const botArrows = botShadowFinalize(ms, myTotal, arrowValues.length);
    _showOppSetLive(ms.oppName, botArrows);
    const botTotal  = botArrows.reduce((a, b) => a + b, 0);
    _resolveSetLocally(myTotal, botTotal, setNumber, ms);
    ms._setSubmitting = false;
    return;
  }

  try {
    const result = await api('POST', `/api/matches/${ms.id}/set`, {
      set_number: setNumber, arrows: myArrows,
    });
    ms._setSubmitting = false;
    _applySetResult(result);
  } catch (e) {
    if (e?.status === 404) {
      ms._setSubmitting = false;
      _setNumpadDisabled(true);
      _setStatus('This match is no longer available.');
      return;
    }
    if (e?.status === 422) {
      ms._setSubmitting = false;
      await _fetchAndResolveMatch(ms.id);
      return;
    }
    showToast('Network error — retrying…', 'error');
    ms._setSubmitting = false;
    _setNumpadDisabled(false);
    _setStatus('');
  }
}

function _resolveSetLocally(myTotal, oppTotal, setNumber, ms) {
  let myPts = 0, oppPts = 0, winner;
  if (myTotal > oppTotal)      { myPts = 2; winner = 'me'; }
  else if (oppTotal > myTotal) { oppPts = 2; winner = 'opponent'; }
  else                          { myPts = 1; oppPts = 1; winner = 'draw'; }

  ms.setMyScore  += myPts;
  ms.setOppScore += oppPts;
  ms.currentSet++;
  refreshSetScore();

  const label = winner === 'me'       ? '✓ You win this set!'
              : winner === 'opponent' ? `${ms.oppName} wins this set`
              :                         'Set draw — 1 pt each';
  showToast(`Set ${setNumber}: ${myTotal} vs ${oppTotal} — ${label}`,
    winner === 'me' ? 'success' : 'info');

  if (ms.setMyScore === 5 && ms.setOppScore === 5) {
    _startTiebreak();
  } else if (ms.setMyScore >= 6 || ms.setOppScore >= 6) {
    completeMatch(ms.setMyScore, ms.setOppScore, ms.id);
  } else {
    _nextSet(setNumber);
  }
  saveMatchState();
}

function _applySetResult(result, targetMatchId) {
  const mid      = targetMatchId || STATE.currentMatchId;
  const ms       = STATE.activeMatches[mid];
  if (!ms) return;
  const isActive = mid === STATE.currentMatchId;

  if (!result.both_submitted) {
    ms._pendingSetNumber = result.set_number;
    if (isActive) {
      // Clear cells and lock numpad — wait for opponent's WS_OPP_SET_DONE
      arrowValues       = new Array(arrowValues.length || 3).fill(null);
      ms.setArrowValues = [];
      activeArrowIndex  = 0;
      buildSetArrowRow();
      refreshSetArrowCells();
      _setNumpadDisabled(true);
      _setStatus(result.judge_status || `Set ${result.set_number}: your arrows recorded. Waiting for ${ms.oppName}…`);
    }
    _scheduleSetResolutionRecovery(mid);
    return;
  }

  const setNumber    = result.set_number;
  delete ms._pendingSetNumber;
  ms.setMyScore      = result.my_set_points;
  ms.setOppScore     = result.opp_set_points;
  ms.currentSet      = setNumber + 1;
  if (result.next_first_to_act) ms.firstToAct = result.next_first_to_act;

  const myName  = ms.myName  || STATE.profile?.name || 'You';
  const oppName = ms.oppName || 'Opponent';
  const winner  = result.set_winner;
  const label   = winner === 'me'       ? `${myName} wins this set!`
                : winner === 'opponent' ? `${oppName} wins this set`
                :                         'Set drawn — 1 pt each';
  showToast(`Set ${setNumber}: ${myName} ${result.my_set_total} – ${oppName} ${result.opp_set_total} — ${label}`,
    winner === 'me' ? 'success' : 'info');

  if (isActive) {
    refreshSetScore();
    _showOppSetArrows(result.opp_set_total, []);
    if (!result.match_complete && !result.tiebreak_required) {
      const youFirst = result.next_first_to_act === STATE.userId;
      const nextMsg  = youFirst ? 'You shoot first next set.' : `${oppName} shoots first next set.`;
      _setStatus(`Set ${setNumber}: ${myName} ${result.my_set_total} – ${oppName} ${result.opp_set_total} — ${label}  [${result.my_set_points}:${result.opp_set_points}]  ${nextMsg}`);
    }
    if      (result.tiebreak_required) {
      _startTiebreak();
      // Confirm the transition from the server so a stale local 5:5 score
      // cannot remain beside the sudden-death UI.
      _fetchAndResolveMatch(mid);
    }
    else if (result.match_complete)    completeMatch(ms.setMyScore, ms.setOppScore, mid, result.match_result ?? null);
    else                               _nextSet(setNumber);
  } else if (result.match_complete) {
    completeMatch(ms.setMyScore, ms.setOppScore, mid, result.match_result ?? null);
  } else if (result.tiebreak_required) {
    ms._tiebreak = true;
    saveMatchState();
    showToast(`${escHtml(oppName)} — sudden death started.`, 'info');
  }
  saveMatchState();
}

function _nextSet(prevSetNumber) {
  const ms = STATE.matchState;
  arrowValues       = new Array(3).fill(null);
  ms.setArrowValues = [];
  ms._oppSetArrows  = [];   // reset live opponent arrows for new set
  activeArrowIndex  = 0;
  buildSetArrowRow();
  refreshSetArrowCells();
  _setNumpadDisabled(false);
  _oppIndicatorHide();  // clear previous set's indicator
  document.getElementById('set-progress').textContent = `Set ${ms.currentSet}`;
  if (ms.firstToAct) {
    const youFirst = ms.firstToAct === STATE.userId;
    _setStatus(youFirst
      ? `Set ${ms.currentSet}: you shoot first. [${ms.setMyScore}:${ms.setOppScore}]`
      : `Set ${ms.currentSet}: ${escHtml(ms.oppName)} shoots first. [${ms.setMyScore}:${ms.setOppScore}]`);
  } else {
    _setStatus('');
  }
}

function _startTiebreak() {
  const ms = STATE.matchState;
  ms._tiebreak      = true;
  ms._pendingTiebreak = false;
  ms._tiebreakSubmitting = false;
  ms._botShadow = null;
  arrowValues       = [null];
  ms.setArrowValues = [];
  activeArrowIndex  = 0;
  buildSetArrowRow(1);
  refreshSetArrowCells();
  _setNumpadDisabled(false);
  _setStatus('');
  document.getElementById('set-progress').textContent = 'Tiebreak — sudden death';
  showToast('Tied at 5:5! One arrow decides — highest score wins.', 'info');
  saveMatchState();
}

async function resolveTiebreak() {
  const ms      = STATE.matchState;
  const myArrow = arrowValues[0];
  if (!ms || myArrow === null || ms._tiebreakSubmitting) return;

  ms._tiebreakSubmitting = true;
  _setNumpadDisabled(true);
  _setStatus('Tiebreak: waiting for opponent…');

  if (ms.isBot) {
    const botArrows = botShadowFinalize(ms, myArrow, 1);
    const botArrow = botArrows[0];
    _showOpponentArrowIndicator(ms.oppName, botArrows);
    if (myArrow === botArrow) {
      showToast(`Both shot ${myArrow}! Shoot again.`, 'info');
      ms._botShadow = null;
      arrowValues = [null]; activeArrowIndex = 0;
      refreshSetArrowCells(); _setNumpadDisabled(false); _setStatus('');
      return;
    }
    const myWins = myArrow > botArrow;
    completeMatch(
      ms.setMyScore  + (myWins  ? 1 : 0),
      ms.setOppScore + (!myWins ? 1 : 0),
      ms.id,
      myWins ? 'me' : 'opponent',
      { my: myArrow, opp: botArrow },
    );
    return;
  }

  try {
    const result = await api('POST', `/api/matches/${ms.id}/set`, {
      set_number: 0, arrows: [myArrow],
    });
    if (!result.both_submitted) {
      _setStatus(`Tiebreak: waiting for ${ms.oppName}…`);
      ms._pendingTiebreak = true;
      ms._tiebreakSubmitting = false;
      _scheduleSetTiebreakRecovery(ms.id);
      return;
    }
    if (result.tiebreak_required) {
      showToast('Both shot equal! Shoot one more arrow.', 'info');
      ms._pendingTiebreak = false;
      ms._tiebreakSubmitting = false;
      arrowValues = [null]; activeArrowIndex = 0;
      refreshSetArrowCells(); _setNumpadDisabled(false); _setStatus('');
      return;
    }
    _setStatus('');
    ms._tiebreakSubmitting = false;
    completeMatch(
      result.my_set_points, result.opp_set_points, ms.id,
      result.match_result ?? null,
      { my: result.my_set_total, opp: result.opp_set_total },
    );
  } catch (e) {
    if (e?.status === 404) {
      _setNumpadDisabled(true);
      _setStatus('This match is no longer available.');
      return;
    }
    if (e?.status === 422) {
      ms._tiebreakSubmitting = false;
      await _fetchAndResolveMatch(ms.id);
      return;
    }
    showToast('Network error on tiebreak', 'error');
    ms._tiebreakSubmitting = false;
    _setNumpadDisabled(false);
    _setStatus('');
  }
}
